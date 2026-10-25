'use strict';
/* =====================================================================
   ESTRUCTURA DEL SCRIPT  (cada bloque es independiente; si el proyecto
   crece, cada uno se puede mover a su propio archivo .js)

   1. CONFIG      ajustes
   2. UTILS       funciones pequeñas
   3. DB          guardado local (IndexedDB)
   4. TAGS        lectura de datos del archivo (nombre, autor, carátula)
   5. STATE       estado de la app
   6. PLAYER      reproducción, cola, aleatorio, repetir
   7. LIBRARY     importar, favoritos, eliminar, listas
   8. UI          dibujar pantalla, menús, diálogos
   9. EVENTS      conectar botones y atajos
   10. INIT       arranque
   ===================================================================== */

/* ============================ 1. CONFIG ============================ */
const CONFIG = {
  logoSrc: 'assets/logo.svg',  // logo de la app (también se usa en el estado vacío)
  dbName: 'qurupeco-db',        // nombre heredado: se mantiene para no perder la biblioteca ya guardada
  dbVersion: 1,
  coverMaxPx: 512,             // tamaño máximo de carátula guardada
  seekStepSec: 5,              // salto con flechas ← →
  volumeStep: 0.05,            // cambio con flechas ↑ ↓
  defaultVolume: 0.8,
  maxFileMB: 50,               // límite por archivo del almacenamiento gratuito
  /* Conexión con Supabase (la clave "publishable" es pública por diseño; lo que protege tus datos son las reglas del proyecto) */
  supabaseUrl: 'https://phhlkybgxezcymixajnj.supabase.co',
  supabaseKey: 'sb_publishable_mir-9ntK2ZBXFsgbuqvGqA_eyyTCeGv',
  /* Worker de Cloudflare que guarda y reproduce las canciones (Backblaze B2). Pega aquí su dirección. */
  workerUrl: 'https://orpheus-audio.frozxd162.workers.dev',
};

/* ============================ 2. UTILS ============================= */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = n => String(n).padStart(2, '0');
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fmtTotal(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
function hash(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function readAsDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
function shuffleArray(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function mimeFor(name, type) {
  if (type) return type;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ({mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg', oga:'audio/ogg', opus:'audio/ogg', wav:'audio/wav', flac:'audio/flac', weba:'audio/webm'})[ext] || 'audio/mpeg';
}

/* ============================== 3. DB ============================== */
/* Dos capas que trabajan juntas:
   · Local → IndexedDB del navegador: solo guarda los datos de la biblioteca (títulos, portadas, listas) para que la página abra rápido.
   · Cloud → Supabase (inicio de sesión + tablas de datos) y un Worker de Cloudflare que guarda las canciones en Backblaze B2.
   El AUDIO nunca se guarda en el dispositivo: se reproduce por streaming desde la nube.
   Stores: items (datos), lists (listas), settings (ajustes, solo locales) · files = solo se usa para subir a la nube la biblioteca antigua */

/* ---- Local (IndexedDB) ---- */
const Local = (() => {
  let db = null, useMem = false;
  const mem = { items: new Map(), files: new Map(), lists: new Map(), settings: new Map() };
  const keyOf = { items: 'id', files: 'id', lists: 'id', settings: 'key' };

  function open() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('sin IndexedDB'));
      const r = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const s of Object.keys(keyOf)) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: keyOf[s] });
      };
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  }
  function tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  return {
    async init() { try { await open(); } catch (e) { useMem = true; console.warn('Guardado local no disponible', e); } return !useMem; },
    all: s => useMem ? Promise.resolve([...mem[s].values()]) : tx(s, 'readonly', st => st.getAll()),
    get: (s, k) => useMem ? Promise.resolve(mem[s].get(k)) : tx(s, 'readonly', st => st.get(k)),
    put: (s, v) => useMem ? (mem[s].set(v[keyOf[s]], v), Promise.resolve()) : tx(s, 'readwrite', st => { st.put(v); }),
    del: (s, k) => useMem ? (mem[s].delete(k), Promise.resolve()) : tx(s, 'readwrite', st => { st.delete(k); }),
    clear: s => useMem ? (mem[s].clear(), Promise.resolve()) : tx(s, 'readwrite', st => { st.clear(); }),
  };
})();

/* ---- Cloud (Supabase, sin librerías: solo fetch) ---- */
const Cloud = (() => {
  const U = CONFIG.supabaseUrl.replace(/\/+$/, ''), K = CONFIG.supabaseKey, SKEY = 'orpheus-session';
  const enc = encodeURIComponent;
  let session = null, refreshing = null;
  try { session = JSON.parse(localStorage.getItem(SKEY)); } catch (e) { session = null; }

  const save = s => {
    session = s;
    try { s ? localStorage.setItem(SKEY, JSON.stringify(s)) : localStorage.removeItem(SKEY); } catch (e) {}
  };
  const fromAuth = j => ({
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    user_id: j.user.id, email: j.user.email,
  });
  function fail(msg, status) { const e = new Error(msg); e.status = status; return e; }

  async function authCall(path, body) {
    const r = await fetch(`${U}/auth/v1/${path}`, {
      method: 'POST', headers: { apikey: K, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(j.error_description || j.msg || j.message || 'Error de autenticación', r.status);
    return j;
  }
  function refresh() {
    if (refreshing) return refreshing;
    const p = (async () => {
      try { save(fromAuth(await authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token }))); }
      catch (e) { if (e.status) save(null); throw e; }     // con status = el servidor la rechazó; sin status = no hay conexión
    })();
    refreshing = p;
    p.then(() => { refreshing = null; }, () => { refreshing = null; });
    return p;
  }
  async function token() {
    if (!session) throw fail('Sin sesión', 401);
    if (session.expires_at - 60 < Date.now() / 1000) await refresh();
    if (!session) throw fail('Sesión caducada', 401);
    return session.access_token;
  }
  async function api(path, opts = {}) {
    const t = await token();
    const r = await fetch(U + path, { ...opts, headers: { apikey: K, Authorization: 'Bearer ' + t, ...(opts.headers || {}) } });
    if (!r.ok) {
      let m = ''; try { const j = await r.json(); m = j.message || j.error || ''; } catch (e) {}
      throw fail(m || `Error ${r.status}`, r.status);
    }
    return r;
  }
  const uid = () => { if (!session) throw fail('Sin sesión', 401); return session.user_id; };
  const W = CONFIG.workerUrl.replace(/\/+$/, '');
  /* Llamadas al Worker (audio): llevan la sesión de Supabase para que sepa que eres tú */
  async function wk(path, opts = {}) {
    const t = await token();
    const r = await fetch(W + path, { ...opts, headers: { Authorization: 'Bearer ' + t, ...(opts.headers || {}) } });
    if (!r.ok) {
      let m = ''; try { const j = await r.json(); m = j.error || j.message || ''; } catch (e) {}
      throw fail(m || `Error ${r.status}`, r.status);
    }
    return r;
  }

  return {
    hasSession: () => !!session,
    token,
    signIn: async (email, password) => { save(fromAuth(await authCall('token?grant_type=password', { email, password }))); },
    signOut: () => save(null),

    /* Datos (títulos, listas…) */
    async pullRows(store) {
      const out = [];
      for (let off = 0; ; off += 1000) {
        const r = await api(`/rest/v1/orpheus_data?select=id,data&store=eq.${store}&order=id&limit=1000&offset=${off}`);
        const rows = await r.json();
        out.push(...rows);
        if (rows.length < 1000) break;
      }
      return out;
    },
    putRow: (store, id, data) => api('/rest/v1/orpheus_data?on_conflict=user_id,store,id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: uid(), store, id, data, updated_at: new Date().toISOString() }),
    }),
    delRow: (store, id) => api(`/rest/v1/orpheus_data?store=eq.${store}&id=eq.${enc(id)}`, { method: 'DELETE' }),

    /* Archivos de audio (Worker → Backblaze B2, bucket privado) */
    uploadFile: (id, blob) => wk('/f/' + enc(id), {
      method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob,
    }),
    /* URL temporal (6 h) para reproducir por streaming; el <audio> no puede mandar la cabecera de sesión */
    async signedUrl(id) {
      const r = await wk('/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const j = await r.json();
      if (!j.url) throw fail('No se pudo preparar la canción', 500);
      return j.url;
    },
    removeFile: id => wk('/f/' + enc(id), { method: 'DELETE' }),
  };
})();

/* ---- DB: lo que usa el resto de la app (misma interfaz de siempre) ---- */
const DB = (() => {
  const META = ['items', 'lists'];                 // lo que se sincroniza como datos
  const SY = 'orpheus-synced', PQ = 'orpheus-pending';
  const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const syncedSet = store => new Set(jget(SY, {})[store] || []);
  const saveSynced = (store, set) => { const a = jget(SY, {}); a[store] = [...set]; jset(SY, a); };
  const mark = (store, id, on) => { const s = syncedSet(store); on ? s.add(id) : s.delete(id); saveSynced(store, s); };

  let seq = 0, timer = null, flushP = null, syncing = false, lastSync = 0;

  /* Cambios pendientes de subir (por ejemplo, hechos sin conexión) */
  function queue(op, store, id) {
    const q = jget(PQ, []).filter(x => !(x.store === store && x.id === id));
    q.push({ op, store, id, n: Date.now() + '-' + (++seq) });
    jset(PQ, q);
    flushSoon();
  }
  function flushSoon() { clearTimeout(timer); timer = setTimeout(() => flush().catch(() => {}), 400); }
  function flush() {
    if (!flushP) flushP = doFlush().finally(() => { flushP = null; });
    return flushP;
  }
  async function doFlush() {
    if (!Cloud.hasSession()) return;
    const q = jget(PQ, []), rest = [];
    for (const x of q) {
      try {
        if (x.op === 'put') {
          const v = await Local.get(x.store, x.id);
          if (v) { await Cloud.putRow(x.store, x.id, v); mark(x.store, x.id, true); }
        } else {
          await Cloud.delRow(x.store, x.id);
          if (x.store === 'items') await Cloud.removeFile(x.id).catch(e => { if (e.status !== 404 && e.status !== 400) throw e; });
          mark(x.store, x.id, false);
        }
      } catch (e) { rest.push(x); }
    }
    const fresh = jget(PQ, []).filter(c => !q.some(y => y.n === c.n));          // encolado mientras se subía
    const keep = rest.filter(r => !fresh.some(f => f.store === r.store && f.id === r.id));
    jset(PQ, [...keep, ...fresh]);
    if (fresh.length) flushSoon();
  }

  /* Trae lo de la nube y deja la copia local igual */
  async function pull() {
    const blocked = new Set(jget(PQ, []).map(x => x.store + ':' + x.id));
    for (const store of META) {
      const rows = await Cloud.pullRows(store);
      const inCloud = new Set(rows.map(r => r.id));
      const local = await Local.all(store);
      const synced = syncedSet(store);
      for (const r of rows) {
        synced.add(r.id);
        if (!blocked.has(store + ':' + r.id)) await Local.put(store, r.data);
      }
      for (const v of local) {
        if (inCloud.has(v.id) || blocked.has(store + ':' + v.id)) continue;
        if (synced.has(v.id)) {                                   // ya estaba en la nube y alguien la borró
          await Local.del(store, v.id);
          if (store === 'items') await Local.del('files', v.id);
          synced.delete(v.id);
        } else {                                                  // solo existe aquí: se sube (migra la biblioteca antigua)
          try {
            if (store === 'items') {
              const f = await Local.get('files', v.id);
              if (!f) { await Local.del('items', v.id); continue; }
              await Cloud.uploadFile(v.id, f.blob);
            }
            await Cloud.putRow(store, v.id, v);
            synced.add(v.id);
          } catch (e) { console.warn('No se pudo subir', v.id, e); }
        }
      }
      saveSynced(store, synced);
    }
    /* El audio no se guarda en el dispositivo: se borran las copias locales de canciones que ya están en la nube */
    const syncedItems = syncedSet('items');
    for (const f of await Local.all('files')) if (syncedItems.has(f.id)) await Local.del('files', f.id);
  }
  /* 'ok' | 'busy' | 'fail' */
  async function sync() {
    if (syncing) return 'busy';
    if (!Cloud.hasSession()) return 'fail';
    syncing = true;
    try { await flush(); await pull(); lastSync = Date.now(); return 'ok'; }
    catch (e) { console.warn('Sincronización fallida', e); return 'fail'; }
    finally { syncing = false; }
  }

  return {
    init: () => Local.init(),
    all: s => Local.all(s),
    get: (s, k) => Local.get(s, k),
    streamUrl: id => Cloud.signedUrl(id),              // reproducción por streaming desde la nube
    async put(s, v) {
      if (s === 'files') { await Cloud.uploadFile(v.id, v.blob); return; }   // el audio va directo a la nube, no se guarda aquí
      await Local.put(s, v);
      if (META.includes(s)) queue('put', s, v.id);
    },
    async del(s, k) {
      await Local.del(s, k);
      if (META.includes(s)) queue('del', s, k);
    },
    sync,
    lastSync: () => lastSync,
    pending: () => jget(PQ, []).length,
    async wipe() {
      for (const s of ['items', 'files', 'lists', 'settings']) await Local.clear(s);
      try { localStorage.removeItem(SY); localStorage.removeItem(PQ); } catch (e) {}
    },
  };
})();

/* ============================= 4. TAGS ============================= */
/* Lector ID3 (v2.2, v2.3, v2.4 y v1): título, autor, álbum y carátula. Sin librerías. */
const Tags = (() => {
  const latin1 = b => { let s = ''; for (const x of b) s += String.fromCharCode(x); return s; };
  const synch = (b, o) => (b[o] << 21) | (b[o+1] << 14) | (b[o+2] << 7) | b[o+3];
  const u32 = (b, o) => ((b[o] << 24) | (b[o+1] << 16) | (b[o+2] << 8) | b[o+3]) >>> 0;
  const u24 = (b, o) => (b[o] << 16) | (b[o+1] << 8) | b[o+2];

  function decode(bytes, enc) {
    let label = 'utf-8', b = bytes;
    if (enc === 0) label = 'windows-1252';
    else if (enc === 1) {
      if (b[0] === 0xFE && b[1] === 0xFF) { label = 'utf-16be'; b = b.subarray(2); }
      else if (b[0] === 0xFF && b[1] === 0xFE) { label = 'utf-16le'; b = b.subarray(2); }
      else label = 'utf-16le';
    } else if (enc === 2) label = 'utf-16be';
    return new TextDecoder(label).decode(b).replace(/\0+$/, '').replace(/\0/g, ', ').trim();
  }
  function skipTerm(d, pos, enc) {
    if (enc === 0 || enc === 3) { while (pos < d.length && d[pos] !== 0) pos++; return pos + 1; }
    while (pos + 1 < d.length && !(d[pos] === 0 && d[pos+1] === 0)) pos += 2;
    return pos + 2;
  }
  function deUnsync(b) {
    const o = [];
    for (let i = 0; i < b.length; i++) { o.push(b[i]); if (b[i] === 0xFF && b[i+1] === 0) i++; }
    return Uint8Array.from(o);
  }
  function parsePic(d, v22) {
    const enc = d[0];
    let p = 1;
    if (v22) p += 3; else { while (p < d.length && d[p] !== 0) p++; p++; }
    const type = d[p]; p++;
    p = skipTerm(d, p, enc);
    return { type, data: d.subarray(p) };
  }
  function sniff(d) {
    if (d[0] === 0xFF && d[1] === 0xD8) return 'image/jpeg';
    if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
    if (d[0] === 0x47 && d[1] === 0x49) return 'image/gif';
    if (d[0] === 0x52 && d[1] === 0x49) return 'image/webp';
    return 'image/jpeg';
  }
  function parseV2(buf) {
    const ver = buf[3], flags = buf[5];
    let b = buf.subarray(0, Math.min(10 + synch(buf, 6), buf.length));
    if ((flags & 0x80) && ver < 4) b = deUnsync(b);
    let pos = 10;
    if (flags & 0x40) pos += ver === 4 ? synch(b, 10) : 4 + u32(b, 10);
    const v22 = ver === 2, hdr = v22 ? 6 : 10, out = {};
    while (pos + hdr <= b.length) {
      if (b[pos] === 0) break;
      const id = latin1(b.subarray(pos, pos + (v22 ? 3 : 4)));
      const size = v22 ? u24(b, pos + 3) : (ver === 4 ? synch(b, pos + 4) : u32(b, pos + 4));
      const ff = v22 ? 0 : b[pos + 9];
      const start = pos + hdr, end = start + size;
      if (size <= 0 || end > b.length) break;
      pos = end;
      if ((ver === 4 && (ff & 0x0C)) || (ver === 3 && (ff & 0xC0))) continue;   // comprimido/cifrado: se omite
      let d = b.subarray(start, end);
      if (ver === 4 && (ff & 0x01)) d = d.subarray(4);
      try {
        if (id === 'TIT2' || id === 'TT2') out.title = decode(d.subarray(1), d[0]);
        else if (id === 'TPE1' || id === 'TP1') out.artist = decode(d.subarray(1), d[0]);
        else if (id === 'TPE2' || id === 'TP2') out.albumArtist = decode(d.subarray(1), d[0]);
        else if (id === 'TALB' || id === 'TAL') out.album = decode(d.subarray(1), d[0]);
        else if (id === 'TRCK' || id === 'TRK') out.track = parseInt(decode(d.subarray(1), d[0]), 10) || 0;
        else if (id === 'APIC' || id === 'PIC') {
          const pic = parsePic(d, v22);
          if (pic.data.length > 100 && (!out.pic || pic.type === 3)) out.pic = pic;
        }
      } catch (e) { /* frame dañado: se ignora */ }
    }
    return out;
  }
  async function readV1(file) {
    if (file.size < 128) return null;
    const b = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
    if (b[0] !== 0x54 || b[1] !== 0x41 || b[2] !== 0x47) return null;
    const s = (o, l) => new TextDecoder('windows-1252').decode(b.subarray(o, o + l)).replace(/\0[\s\S]*$/, '').trim();
    return { title: s(3, 30), artist: s(33, 30), album: s(63, 30) };
  }
  async function shrinkCover(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, CONFIG.coverMaxPx / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const out = await new Promise(r => c.toBlob(x => r(x || blob), 'image/jpeg', 0.85));
      return await readAsDataURL(out);
    } catch (e) { return await readAsDataURL(blob); }
  }
  /* Devuelve { title, artist, album, cover(data URL | null) } */
  async function read(file) {
    const r = { title: '', artist: '', album: '', track: 0, cover: null };
    try {
      const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
      if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
        const buf = new Uint8Array(await file.slice(0, 10 + synch(head, 6)).arrayBuffer());
        const t = parseV2(buf);
        r.title = t.title || ''; r.artist = t.artist || t.albumArtist || ''; r.album = t.album || ''; r.track = t.track || 0;
        if (t.pic) r.cover = await shrinkCover(new Blob([t.pic.data], { type: sniff(t.pic.data) }));
      }
      if (!r.title || !r.artist) {
        const v1 = await readV1(file);
        if (v1) { r.title = r.title || v1.title; r.artist = r.artist || v1.artist; r.album = r.album || v1.album; }
      }
    } catch (e) { console.warn('Datos del archivo no legibles', e); }
    return r;
  }
  return { read };
})();

/* ============================ 5. STATE ============================= */
const state = {
  items: new Map(),                 // id -> { id, title, artist, album, duration, cover, fav, added, size, sig }
  lists: [],                        // { id, name, ids[], created }
  view: { type: 'library', id: null },   // library | favorites | list
  query: '', sort: 'added',
  queue: [], order: [], pos: -1,    // cola base, orden real (con aleatorio / arrastre) y posición
  source: { type: 'library', id: null, sort: 'added' },   // de dónde salió la cola
  temp: new Set(),                  // ids añadidos a la cola de forma temporal (búsqueda)
  expanded: false,                  // ventana de reproducción desplegada
  currentId: null, currentBlob: null, currentUrl: null,
  shuffle: false, repeat: 'off',    // off | all | one
};
const audio = new Audio();
audio.preload = 'auto';
let playToken = 0, errorStreak = 0, triedData = false, scrubbing = false;

/* =========================== 6. PLAYER ============================= */
function buildOrder(startId) {
  const ids = [...state.queue];
  if (state.shuffle) {
    shuffleArray(ids);
    const i = ids.indexOf(startId);
    if (i > 0) { ids.splice(i, 1); ids.unshift(startId); }
    state.pos = ids.length ? 0 : -1;
  } else {
    state.pos = Math.max(0, ids.indexOf(startId));
  }
  state.order = ids;
}
/* ---- Cola de reproducción (estilo Lark Player) ----
   · Elegir algo en una vista distinta a la de la cola → se genera una cola nueva con TODA esa vista
     (en orden, o mezclada si el aleatorio está activo).
   · Elegir algo en la misma vista, o desde una búsqueda → NO se crea otra cola: se salta a ese elemento
     (si no estaba en la cola, se inserta como temporal justo después del actual). */
const viewSource = () => { const v = state.view; return v.type === 'albums' ? { type: 'library', id: null } : { type: v.type, id: v.id }; };
const sameSource = () => { const s = state.source, v = viewSource(); return s.type === v.type && (s.id || null) === (v.id || null) && s.sort === state.sort; };

function startQueue(ids, source, startId) {
  state.queue = [...ids];
  if (!state.queue.includes(startId)) state.queue.push(startId);
  state.source = { ...source, sort: source.sort ?? state.sort };
  state.temp.clear();
  buildOrder(startId);
  refreshQueue();
  playId(startId);
}
function jumpTo(i) { state.pos = i; playId(state.order[i]); }
function insertNext(id) {
  const at = state.pos + 1;
  state.order.splice(at, 0, id);
  const qi = state.queue.indexOf(state.currentId);
  state.queue.splice(qi < 0 ? state.queue.length : qi + 1, 0, id);
  state.temp.add(id);
  state.pos = at;
  refreshQueue();
  playId(id);
}
/* Buscar + play de algo que ya está en la cola: se saca de su sitio y pasa a sonar justo después del actual */
function moveNext(id) {
  const from = state.order.indexOf(id);
  if (from < 0) return insertNext(id);
  state.order.splice(from, 1);
  if (from < state.pos) state.pos--;
  const at = state.pos + 1;
  state.order.splice(at, 0, id);
  state.queue = state.queue.filter(x => x !== id);
  const qi = state.queue.indexOf(state.currentId);
  state.queue.splice(qi < 0 ? state.queue.length : qi + 1, 0, id);
  state.pos = at;
  refreshQueue();
  playId(id);
}
function playFromView(id, force = false) {
  const idx = state.order.indexOf(id);
  const searching = !!state.query.trim();
  if (!force && state.order.length) {
    if (idx >= 0 && searching) return moveNext(id);
    if (idx >= 0 && sameSource()) return jumpTo(idx);
    if (idx < 0 && searching) return insertNext(id);
  }
  startQueue(visibleItems(false).map(i => i.id), viewSource(), id);
}
/* Un elemento al azar de toda la biblioteca; deja el aleatorio activado para lo que sigue */
function playRandom() {
  const all = [...state.items.values()].sort((a, b) => b.added - a.added);
  if (!all.length) { toast('La biblioteca está vacía'); return; }
  state.shuffle = true; savePrefs(); updateModes();
  const pick = all[Math.floor(Math.random() * all.length)];
  startQueue(all.map(i => i.id), { type: 'library', id: null, sort: 'added' }, pick.id);
}
async function loadSource(url) {
  state.currentUrl = url;
  audio.src = url;
  try { await audio.play(); } catch (e) { /* el navegador pidió interacción: queda en pausa */ }
}
async function playId(id) {
  const item = state.items.get(id);
  if (!item) return;
  const token = ++playToken;
  let url = null;
  try { url = await DB.streamUrl(id); } catch (e) { console.warn(e); }
  if (token !== playToken) return;
  if (!url) { toast('No se puede reproducir: revisa tu conexión'); return; }
  state.currentId = id; triedData = false;
  updateNowPlaying(); markPlaying(); setMediaSession(item); markQueue();
  await loadSource(url);
}
function step(dir, auto = false) {
  if (!state.order.length) return;
  if (auto && state.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  let p = state.pos + dir;
  if (p >= state.order.length) {
    if (state.repeat === 'all' || !auto) { if (state.shuffle) shuffleArray(state.order); p = 0; refreshQueue(); }
    else { audio.pause(); audio.currentTime = 0; return; }
  }
  if (p < 0) p = state.order.length - 1;
  state.pos = p;
  playId(state.order[p]);
}
function prev() { if (audio.currentTime > 3) audio.currentTime = 0; else step(-1); }
function togglePlay() {
  if (!state.currentId) {
    const first = visibleItems()[0];
    if (first) playFromView(first.id);
    return;
  }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function toggleShuffle() {
  state.shuffle = !state.shuffle;
  if (state.queue.length) { buildOrder(state.currentId); refreshQueue(); }
  savePrefs(); updateModes();
}
function cycleRepeat() {
  state.repeat = ({ off: 'all', all: 'one', one: 'off' })[state.repeat];
  savePrefs(); updateModes();
}
function stopPlayback() {
  playToken++;
  audio.pause(); audio.removeAttribute('src'); audio.load();
  if (state.currentUrl && state.currentUrl.startsWith('blob:')) URL.revokeObjectURL(state.currentUrl);
  state.currentId = null; state.currentBlob = null; state.currentUrl = null;
  updateNowPlaying(); markPlaying(); updateTimes();
}
function setMediaSession(item) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title, artist: item.artist || '', album: item.album || '',
      artwork: item.cover ? [{ src: item.cover, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  } catch (e) {}
}
function savePrefs() {
  DB.put('settings', { key: 'prefs', volume: audio.volume, shuffle: state.shuffle, repeat: state.repeat }).catch(() => {});
}

/* ========================== 7. LIBRARY ============================= */
function getList(id) { return state.lists.find(l => l.id === id); }
function saveList(l) { return DB.put('lists', l); }

const albumKey = a => String(a || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/* Álbumes automáticos: se agrupan los elementos que comparten el campo Álbum */
function getAlbums() {
  const map = new Map();
  for (const it of state.items.values()) {
    const k = albumKey(it.album); if (!k) continue;
    let a = map.get(k);
    if (!a) { a = { key: k, name: it.album.trim(), ids: [], artists: new Map(), cover: null, duration: 0 }; map.set(k, a); }
    a.ids.push(it.id); a.duration += it.duration || 0;
    if (!a.cover && it.cover) a.cover = it.cover;
    const ar = (it.artist || '').trim(); if (ar) a.artists.set(ar, (a.artists.get(ar) || 0) + 1);
  }
  return [...map.values()].map(a => {
    const top = [...a.artists.entries()].sort((x, y) => y[1] - x[1])[0];
    a.artist = !top ? '' : (top[1] / a.ids.length >= 0.5 ? top[0] : 'Varios autores');
    return a;
  }).sort((x, y) => collator.compare(x.name, y.name));
}
const getAlbum = key => getAlbums().find(a => a.key === key);

function visibleItems(withQuery = true) {
  const v = state.view;
  let arr;
  if (v.type === 'library' || v.type === 'albums') arr = [...state.items.values()];
  else if (v.type === 'favorites') arr = [...state.items.values()].filter(i => i.fav);
  else if (v.type === 'album') arr = [...state.items.values()].filter(i => albumKey(i.album) === v.id);
  else arr = (getList(v.id)?.ids || []).map(id => state.items.get(id)).filter(Boolean);
  const q = state.query.trim().toLowerCase();
  if (withQuery && q) arr = arr.filter(i => `${i.title} ${i.artist} ${i.album}`.toLowerCase().includes(q));
  const s = state.sort;
  if (s === 'added') arr.sort((a, b) => b.added - a.added);
  else if (s === 'track') arr.sort((a, b) => (a.track || 1e6) - (b.track || 1e6) || collator.compare(a.title, b.title));
  else if (s === 'title') arr.sort((a, b) => collator.compare(a.title, b.title));
  else if (s === 'artist') arr.sort((a, b) => collator.compare(a.artist || '\uffff', b.artist || '\uffff') || collator.compare(a.title, b.title));
  return arr;
}

function getDuration(blob) {
  return new Promise(res => {
    const a = new Audio(), u = URL.createObjectURL(blob);
    const done = d => { URL.revokeObjectURL(u); a.removeAttribute('src'); res(isFinite(d) ? d : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = u;
  });
}

async function importFiles(fileList) {
  const files = [...fileList].filter(f => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba)$/i.test(f.name));
  if (!files.length) { toast('Esos archivos no se pueden añadir'); return; }
  const known = new Set([...state.items.values()].map(i => i.sig));
  let ok = 0, dup = 0, fail = 0, lastErr = '';
  const maxB = CONFIG.maxFileMB * 1024 * 1024;
  for (let n = 0; n < files.length; n++) {
    const f = files[n];
    toast(`Añadiendo ${n + 1} de ${files.length}…`, 0);
    const sig = `${f.name}|${f.size}|${f.lastModified}`;
    if (known.has(sig)) { dup++; continue; }
    if (f.size > maxB) { fail++; lastErr = `máx. ${CONFIG.maxFileMB} MB por archivo`; continue; }
    try {
      const meta = await Tags.read(f);
      const blob = new Blob([f], { type: mimeFor(f.name, f.type) });
      const duration = await getDuration(blob);
      const base = f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
      if (!meta.title) {
        const m = base.match(/^(.+?)\s+-\s+(.+)$/);
        if (m && !meta.artist) { meta.artist = m[1].trim(); meta.title = m[2].trim(); } else meta.title = base;
      }
      const item = { id: uid(), title: meta.title, artist: meta.artist, album: meta.album, track: meta.track || 0, duration, cover: meta.cover, fav: false, added: Date.now() + n, size: f.size, sig };
      await DB.put('files', { id: item.id, blob });
      await DB.put('items', item);
      state.items.set(item.id, item);
      known.add(sig);
      ok++;
      if (ok % 4 === 0) { renderNav(); renderMain(); }
    } catch (e) { fail++; lastErr = e.message || ''; console.error(e); }
  }
  renderNav(); renderMain();
  const parts = [];
  if (ok) parts.push(`${ok} ${ok === 1 ? 'añadido' : 'añadidos'}`);
  if (dup) parts.push(`${dup} ya ${dup === 1 ? 'estaba' : 'estaban'}`);
  if (fail) parts.push(`${fail} con error${lastErr ? ' (' + lastErr.slice(0, 80) + ')' : ''}`);
  toast(parts.join(', '), fail ? 6000 : 2800);
}

async function toggleFav(id) {
  const it = state.items.get(id); if (!it) return;
  it.fav = !it.fav;
  await DB.put('items', it);
  renderNav(); renderRows();
}

async function deleteItem(id) {
  const it = state.items.get(id); if (!it) return;
  const ok = await ask({ title: 'Eliminar de la biblioteca', text: `«${it.title}» se quitará de la biblioteca y de todas las listas.`, ok: 'Eliminar' });
  if (!ok) return;
  if (state.currentId === id) stopPlayback();
  state.items.delete(id);
  await DB.del('items', id); await DB.del('files', id);
  for (const l of state.lists) if (l.ids.includes(id)) { l.ids = l.ids.filter(x => x !== id); await saveList(l); }
  state.queue = state.queue.filter(x => x !== id);
  state.order = state.order.filter(x => x !== id);
  state.pos = Math.max(0, state.order.indexOf(state.currentId));
  state.temp.delete(id); refreshQueue();
  renderNav(); renderMain();
}

async function newList(itemId) {
  const name = await ask({ title: 'Nueva lista', input: '', placeholder: 'Nombre de la lista', ok: 'Crear' });
  if (!name) return null;
  const l = { id: uid(), name, ids: itemId ? [itemId] : [], created: Date.now() };
  state.lists.push(l);
  await saveList(l);
  renderNav(); if (state.view.type === 'list') renderMain();
  toast(itemId ? `Añadido a «${name}»` : `Lista «${name}» creada`);
  return l;
}
async function renameList() {
  const l = getList(state.view.id); if (!l) return;
  const name = await ask({ title: 'Renombrar lista', input: l.name, ok: 'Guardar' });
  if (!name) return;
  l.name = name; await saveList(l); renderNav(); renderMain();
}
async function deleteList() {
  const l = getList(state.view.id); if (!l) return;
  const ok = await ask({ title: 'Eliminar lista', text: `Se eliminará «${l.name}». Los archivos seguirán en la biblioteca.`, ok: 'Eliminar' });
  if (!ok) return;
  state.lists = state.lists.filter(x => x.id !== l.id);
  await DB.del('lists', l.id);
  setView('library');
}
async function addToList(listId, itemId) {
  const l = getList(listId); if (!l) return;
  if (l.ids.includes(itemId)) { toast('Ya está en esa lista'); return; }
  l.ids.push(itemId); await saveList(l);
  renderNav(); toast(`Añadido a «${l.name}»`);
}
async function removeFromList(itemId) {
  const l = getList(state.view.id); if (!l) return;
  l.ids = l.ids.filter(x => x !== itemId); await saveList(l);
  renderNav(); renderMain();
}

/* ============================== 8. UI ============================== */
const PLACEHOLDER_VARIANTS = 4;   // debe coincidir con las variantes .ph[data-v] del CSS
function coverHTML(it) {
  return it.cover
    ? `<img src="${it.cover}" alt="" loading="lazy" decoding="async">`
    : `<div class="ph" data-v="${hash(it.id) % PLACEHOLDER_VARIANTS}">${esc((it.title || '?').trim().charAt(0).toUpperCase())}</div>`;
}
const icon = (name, extra = '') => `<svg class="i" ${extra}><use href="#i-${name}"/></svg>`;

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* Diálogo reutilizable: texto (input) o confirmación */
function ask({ title, text = '', input = null, placeholder = '', ok = 'Aceptar' }) {
  return new Promise(res => {
    const dlg = $('#dlg'), inp = $('#dlgInput');
    $('#dlgTitle').textContent = title;
    $('#dlgText').textContent = text; $('#dlgText').hidden = !text;
    inp.hidden = input === null; inp.value = input ?? ''; inp.placeholder = placeholder;
    $('#dlgOk').textContent = ok;
    const close = v => { dlg.close(); res(v); };
    $('#dlgOk').onclick = () => close(input !== null ? (inp.value.trim() || null) : true);
    $('#dlgCancel').onclick = () => close(null);
    dlg.oncancel = () => res(null);
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#dlgOk').click(); } };
    dlg.showModal();
    if (input !== null) { inp.focus(); inp.select(); }
  });
}

/* Menú contextual de cada elemento */
function openMenu(btn, id) {
  const menu = $('#menu');
  const inList = state.view.type === 'list';
  const itm = state.items.get(id);
  menu.innerHTML =
    `<button type="button" role="menuitem" data-m="edit">Editar información…</button>` +
    (itm?.album ? `<button type="button" role="menuitem" data-m="goalbum">Ir al álbum</button>` : '') + `<hr>` +
    (state.lists.length ? `<div class="mh">Añadir a una lista</div>` + state.lists.map(l => `<button type="button" role="menuitem" data-m="add" data-list="${l.id}">${esc(l.name)}</button>`).join('') : '') +
    `<button type="button" role="menuitem" data-m="newlist">Nueva lista…</button><hr>` +
    (inList ? `<button type="button" role="menuitem" data-m="remove">Quitar de esta lista</button>` : '') +
    `<button type="button" role="menuitem" class="danger" data-m="delete">Eliminar de la biblioteca</button>`;
  menu.dataset.id = id;
  menu.hidden = false;
  const r = btn.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
  let x = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
  let y = r.bottom + 4; if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 4);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
}
const closeMenu = () => { $('#menu').hidden = true; };

function setView(type, id = null) {
  state.view = { type, id };
  state.query = ''; $('#search').value = '';
  state.sort = type === 'list' ? 'manual' : type === 'album' ? 'track' : 'added';
  buildSortOptions(); renderNav(); renderMain();
  $('#rows').scrollTop = 0;
}
function buildSortOptions() {
  const opts = [['added', 'Recientes'], ['title', 'Título'], ['artist', 'Autor']];
  if (state.view.type === 'list') opts.unshift(['manual', 'Orden de la lista']);
  if (state.view.type === 'album') opts.unshift(['track', 'Nº de pista']);
  const sel = $('#sort');
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  sel.value = state.sort;
}

function renderNav() {
  const v = state.view;
  const cur = (t, id) => (v.type === t && (v.id || null) === (id || null)) ? ' aria-current="page"' : '';
  let h = `<button class="nav-item" type="button" data-view="library"${cur('library')}>${icon('grid')}<span>Biblioteca</span><em>${state.items.size}</em></button>`;
  h += `<button class="nav-item" type="button" data-view="favorites"${cur('favorites')}>${icon('heart')}<span>Favoritos</span><em>${[...state.items.values()].filter(i => i.fav).length}</em></button>`;
  h += `<button class="nav-item" type="button" data-view="albums"${(v.type === 'albums' || v.type === 'album') ? ' aria-current="page"' : ''}>${icon('disc')}<span>Álbumes</span><em>${getAlbums().length}</em></button>`;
  h += `<div class="nav-label">Listas</div>`;
  h += state.lists.map(l => `<button class="nav-item" type="button" data-view="list" data-id="${l.id}"${cur('list', l.id)}>${icon('list')}<span>${esc(l.name)}</span><em>${l.ids.filter(i => state.items.has(i)).length}</em></button>`).join('');
  h += `<button class="nav-item new" type="button" data-act="newlist">${icon('plus')}<span>Nueva lista</span></button>`;
  h += `<button class="nav-item new" type="button" data-act="logout">${icon('logout')}<span>Cerrar sesión</span></button>`;
  $('#nav').innerHTML = h;
}

function renderMain() {
  const v = state.view;
  if (v.type === 'album' && !getAlbum(v.id)) return setView('albums');
  let title = 'Biblioteca';
  if (v.type === 'favorites') title = 'Favoritos';
  if (v.type === 'albums') title = 'Álbumes';
  if (v.type === 'album') title = getAlbum(v.id).name;
  if (v.type === 'list') title = getList(v.id)?.name || 'Lista';
  $('#viewTitle').textContent = title;
  $('#viewActions').innerHTML = v.type === 'list'
    ? `<button class="btn ghost" type="button" data-act="rename-list">Renombrar</button><button class="btn ghost danger" type="button" data-act="delete-list">Eliminar lista</button>`
    : v.type === 'album' ? `<button class="btn ghost" type="button" data-act="to-albums">Todos los álbumes</button>` : '';
  $('#playAll').hidden = $('#sort').hidden = v.type === 'albums';
  renderRows();
}

function emptyHTML() {
  const v = state.view;
  if (state.query.trim()) return `<div class="empty"><div class="big">Sin resultados</div><p>No hay nada que coincida con «${esc(state.query)}».</p></div>`;
  if (v.type === 'favorites') return `<div class="empty"><div class="big">Aún no hay favoritos</div><p>Marca el corazón de cualquier elemento y aparecerá aquí.</p></div>`;
  if (v.type === 'albums') return `<div class="empty"><div class="big">Aún no hay álbumes</div><p>Se crean solos cuando varios elementos comparten el campo Álbum. Puedes editarlo desde el menú ⋯.</p></div>`;
  if (v.type === 'list') return `<div class="empty"><div class="big">Esta lista está vacía</div><p>Abre el menú ⋯ de un elemento de la biblioteca y elige esta lista.</p></div>`;
  return `<div class="empty"><img class="empty-logo" src="${CONFIG.logoSrc}" alt=""><div class="big">Todo listo para empezar</div><p>Arrastra tus archivos a esta ventana o pulsa el botón para añadirlos.</p><button class="btn primary" type="button" data-act="add">${icon('plus')}Añadir archivos</button></div>`;
}

function rowHTML(it) {
  return `<div class="row" role="listitem" tabindex="0" data-id="${it.id}">
    <div class="thumb">${coverHTML(it)}<span class="pl">${icon('play')}</span></div>
    <div class="meta"><div class="t">${esc(it.title)}</div><div class="a">${esc(it.artist || 'Sin autor')}</div></div>
    <div class="alb">${esc(it.album)}</div>
    <div class="dur">${it.duration ? fmt(it.duration) : ''}</div>
    <button class="icon-btn fav" type="button" data-act="fav" aria-label="Favorito" aria-pressed="${it.fav}">${icon('heart')}</button>
    <button class="icon-btn" type="button" data-act="more" aria-label="Más opciones" aria-haspopup="menu">${icon('more', 'style="fill:currentColor"')}</button>
  </div>`;
}

const albumHTML = a => `<button class="album" type="button" data-album="${esc(a.key)}">
    <div class="alb-cover">${a.cover ? `<img src="${a.cover}" alt="" loading="lazy" decoding="async">` : `<div class="ph" data-v="${hash(a.key) % PLACEHOLDER_VARIANTS}">${esc(a.name.charAt(0).toUpperCase())}</div>`}</div>
    <div class="alb-name">${esc(a.name)}</div>
    <div class="alb-sub">${esc(a.artist || 'Sin autor')} · ${a.ids.length}</div>
  </button>`;

function renderRows() {
  const v = state.view;
  $('#playShuffle').disabled = !state.items.size;
  if (v.type === 'albums') {
    const q = state.query.trim().toLowerCase();
    const albums = getAlbums().filter(a => !q || `${a.name} ${a.artist}`.toLowerCase().includes(q));
    $('#viewSub').textContent = albums.length ? `${albums.length} ${albums.length === 1 ? 'álbum' : 'álbumes'}` : '';
    $('#rows').innerHTML = albums.length ? `<div class="album-grid">${albums.map(albumHTML).join('')}</div>` : emptyHTML();
    return;
  }
  const arr = visibleItems();
  const total = arr.reduce((s, i) => s + (i.duration || 0), 0);
  let sub = arr.length ? `${arr.length} ${arr.length === 1 ? 'elemento' : 'elementos'}${total ? ', ' + fmtTotal(total) : ''}` : '';
  if (v.type === 'album' && sub) { const a = getAlbum(v.id); if (a?.artist) sub = `${a.artist} · ${sub}`; }
  $('#viewSub').textContent = sub;
  $('#playAll').disabled = !arr.length;
  $('#rows').innerHTML = arr.length ? arr.map(rowHTML).join('') : emptyHTML();
  markPlaying();
}

function markPlaying() {
  const playing = !audio.paused && !audio.ended && !!state.currentId;
  $$('.row').forEach(r => {
    const cur = r.dataset.id === state.currentId;
    r.classList.toggle('current', cur);
    r.querySelector('.pl use').setAttribute('href', cur && playing ? '#i-pause' : '#i-play');
  });
}

function updateNowPlaying() {
  const it = state.items.get(state.currentId);
  $('#player').classList.toggle('idle', !it);
  $('#npTitle').textContent = it ? it.title : 'Nada seleccionado';
  $('#npArtist').textContent = it ? (it.artist || 'Sin autor') : 'Elige algo de la biblioteca';
  $('#npCover').innerHTML = it ? coverHTML(it) : icon('feather', 'style="width:26px;height:26px"');
  updatePlayIcon();
  if (!it && state.expanded) setExpanded(false);
}
function updatePlayIcon() {
  const playing = !audio.paused && !audio.ended;
  $('#playBtn use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#playBtn').setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
}
function updateModes() {
  const s = $('#shuffleBtn'), r = $('#repeatBtn');
  s.setAttribute('aria-pressed', state.shuffle);
  r.setAttribute('aria-pressed', state.repeat !== 'off');
  r.setAttribute('aria-label', 'Repetir: ' + ({ off: 'desactivado', all: 'todo', one: 'uno' })[state.repeat]);
  r.querySelector('.badge').hidden = state.repeat !== 'one';
}
function setRange(el, val, max) { el.value = val; el.style.setProperty('--p', (max ? Math.min(100, (val / max) * 100) : 0) + '%'); }
function updateTimes() {
  const d = isFinite(audio.duration) ? audio.duration : (state.items.get(state.currentId)?.duration || 0);
  $('#tCur').textContent = fmt(audio.currentTime || 0);
  $('#tDur').textContent = fmt(d);
  if (!scrubbing) setRange($('#seek'), d ? (audio.currentTime / d) * 1000 : 0, 1000);
}
function updateVolume() {
  const v = audio.muted ? 0 : audio.volume;
  setRange($('#volume'), v, 1);
  $('#muteBtn use').setAttribute('href', v === 0 ? '#i-mute' : '#i-vol');
}
/* ---- Cola de reproducción: ventana desplegable ---- */
function sourceLabel() {
  const s = state.source;
  if (s.type === 'favorites') return 'Favoritos';
  if (s.type === 'album') return getAlbum(s.id)?.name || 'Álbum';
  if (s.type === 'list') return getList(s.id)?.name || 'Lista';
  return 'Biblioteca';
}
function queueRowHTML(id) {
  const it = state.items.get(id); if (!it) return '';
  return `<div class="q-row" role="listitem" data-id="${id}">
    <span class="q-handle" aria-label="Arrastrar para cambiar el orden">${icon('grip', 'style="fill:currentColor"')}</span>
    <div class="thumb">${coverHTML(it)}</div>
    <div class="meta"><div class="t">${esc(it.title)}</div><div class="a">${esc(it.artist || 'Sin autor')}${state.temp.has(id) ? ' · temporal' : ''}</div></div>
    <div class="dur">${it.duration ? fmt(it.duration) : ''}</div>
    <button class="icon-btn" type="button" data-q="rm" aria-label="Quitar de la cola">${icon('x')}</button>
  </div>`;
}
function renderQueue() {
  $('#qList').innerHTML = state.order.map(queueRowHTML).join('');
  $('#qInfo').textContent = `${sourceLabel()} · ${state.order.length}${state.shuffle ? ' · aleatorio' : ''}`;
  markQueue();
}
const refreshQueue = () => { if (state.expanded) renderQueue(); };
function markQueue() {
  if (!state.expanded) return;
  const rows = $('#qList').children;
  for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('current', i === state.pos);
}
function setExpanded(on) {
  if (on && !state.currentId) return;
  state.expanded = on;
  $('#player').classList.toggle('expanded', on);
  $('#queue').hidden = !on;
  const b = $('#expandBtn');
  b.setAttribute('aria-expanded', String(on));
  b.setAttribute('aria-label', on ? 'Cerrar cola de reproducción' : 'Abrir cola de reproducción');
  if (on) { renderQueue(); $('#player').scrollTop = 0; }
}
function removeFromQueue(i) {
  const id = state.order[i]; if (id == null) return;
  const wasCurrent = i === state.pos;
  state.order.splice(i, 1);
  state.queue = state.queue.filter(x => x !== id);
  state.temp.delete(id);
  if (i < state.pos) state.pos--;
  if (wasCurrent) {
    if (!state.order.length) { state.pos = -1; stopPlayback(); return; }
    state.pos = Math.min(i, state.order.length - 1);
    playId(state.order[state.pos]);
  }
  renderQueue();
}
/* Arrastrar para reordenar (puntero: sirve con ratón y con dedo) */
function bindQueue() {
  const list = $('#qList');
  let drag = null;
  list.addEventListener('pointerdown', e => {
    const h = e.target.closest('.q-handle'); if (!h) return;
    e.preventDefault();
    list.setPointerCapture(e.pointerId);
    drag = { row: h.closest('.q-row'), pid: e.pointerId };
    drag.row.classList.add('dragging');
  });
  list.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pid) return;
    const sc = $('#player'), r = sc.getBoundingClientRect();
    if (e.clientY < r.top + 36) sc.scrollTop -= 14; else if (e.clientY > r.bottom - 36) sc.scrollTop += 14;
    let before = null;
    for (const s of list.children) {
      if (s === drag.row) continue;
      const b = s.getBoundingClientRect();
      if (e.clientY < b.top + b.height / 2) { before = s; break; }
    }
    if (before !== drag.row.nextElementSibling) list.insertBefore(drag.row, before);
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.pid) return;
    drag.row.classList.remove('dragging'); drag = null;
    const ids = [...list.children].map(r => r.dataset.id);
    if (ids.join() === state.order.join()) return;
    state.order = ids;
    if (!state.shuffle) state.queue = [...ids];          // sin aleatorio, el nuevo orden pasa a ser el orden base
    state.pos = Math.max(0, ids.indexOf(state.currentId));
    markQueue();
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
  list.addEventListener('click', e => {
    const row = e.target.closest('.q-row'); if (!row || e.target.closest('.q-handle')) return;
    const i = [...list.children].indexOf(row);
    if (e.target.closest('[data-q="rm"]')) return removeFromQueue(i);
    if (i === state.pos) return togglePlay();
    jumpTo(i);
  });
}

/* Deslizar hacia abajo para cerrar la ventana (solo si el panel está arriba del todo) */
function bindSheet() {
  const p = $('#player');
  let y0 = null, dy = 0;
  p.addEventListener('touchstart', e => {
    if (!state.expanded || p.scrollTop > 0 || e.target.closest('.q-handle,input[type=range]')) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  p.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0 && p.scrollTop <= 0) {
      if (e.cancelable) e.preventDefault();
      p.style.transition = 'none'; p.style.transform = `translateY(${dy}px)`;
    } else { p.style.transform = ''; }
  }, { passive: false });
  const end = () => {
    if (y0 == null) return;
    const close = dy > 110;
    y0 = null; dy = 0;
    p.style.transition = 'transform .18s';
    p.style.transform = close ? 'translateY(100%)' : '';
    setTimeout(() => { p.style.transition = ''; if (close) { setExpanded(false); p.style.transform = ''; } }, 190);
  };
  p.addEventListener('touchend', end);
  p.addEventListener('touchcancel', end);
}

/* ---- Editar información (título, autor, álbum, nº de pista) ---- */
let editingId = null;
function editItem(id) {
  const it = state.items.get(id); if (!it) return;
  editingId = id;
  const all = [...state.items.values()];
  const uniq = arr => [...new Set(arr.map(x => (x || '').trim()).filter(Boolean))].sort(collator.compare);
  $('#dlArtists').innerHTML = uniq(all.map(i => i.artist)).map(a => `<option value="${esc(a)}">`).join('');
  $('#dlAlbums').innerHTML = uniq(all.map(i => i.album)).map(a => `<option value="${esc(a)}">`).join('');
  $('#edTitle').value = it.title || '';
  $('#edArtist').value = it.artist || '';
  $('#edAlbum').value = it.album || '';
  $('#edTrack').value = it.track || '';
  $('#editDlg').showModal();
  $('#edTitle').focus(); $('#edTitle').select();
}
async function saveEdit(e) {
  e.preventDefault();
  const it = state.items.get(editingId);
  if (!it) return $('#editDlg').close();
  const title = $('#edTitle').value.trim();
  if (!title) return $('#edTitle').focus();
  it.title = title;
  it.artist = $('#edArtist').value.trim();
  it.album = $('#edAlbum').value.trim();
  it.track = Math.max(0, parseInt($('#edTrack').value, 10) || 0);
  $('#editDlg').close();
  await DB.put('items', it);
  if (state.currentId === it.id) { updateNowPlaying(); setMediaSession(it); }
  renderNav(); renderMain(); refreshQueue();
  toast('Información guardada');
}

/* ---- Cabecera plegable ---- */
function setHeadCollapsed(on, save = true) {
  $('#head').classList.toggle('collapsed', on);
  $('#app').classList.toggle('top-hidden', on);
  const b = $('#headToggle');
  b.setAttribute('aria-expanded', String(!on));
  b.setAttribute('aria-label', on ? 'Mostrar herramientas' : 'Ocultar herramientas');
  if (save) { try { localStorage.setItem('orpheus-head', on ? '1' : '0'); } catch (e) {} }
}

/* ============================ 9. EVENTS ============================ */
function bindEvents() {
  /* Navegación */
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'newlist') return newList().then(l => l && setView('list', l.id));
    if (b.dataset.act === 'logout') return logout();
    if (b.dataset.view) setView(b.dataset.view, b.dataset.id || null);
  });

  /* Cabecera */
  $('#addBtn').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = e => { importFiles(e.target.files); e.target.value = ''; };
  $('#playAll').onclick = () => { const a = visibleItems(); if (a.length) playFromView(a[0].id, true); };
  $('#playShuffle').onclick = playRandom;
  $('#headToggle').onclick = () => setHeadCollapsed(!$('#head').classList.contains('collapsed'));
  $('#editForm').onsubmit = saveEdit;
  $('#edCancel').onclick = () => $('#editDlg').close();
  $('#search').oninput = e => { state.query = e.target.value; renderRows(); };
  $('#sort').onchange = e => { state.sort = e.target.value; renderRows(); };
  $('.head').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'rename-list') renameList();
    if (b.dataset.act === 'delete-list') deleteList();
    if (b.dataset.act === 'to-albums') setView('albums');
  });

  /* Filas */
  const rows = $('#rows');
  rows.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'add') return $('#fileInput').click();
    const al = e.target.closest('.album'); if (al) return setView('album', al.dataset.album);
    const row = e.target.closest('.row'); if (!row) return;
    const id = row.dataset.id;
    if (act?.dataset.act === 'fav') return toggleFav(id);
    if (act?.dataset.act === 'more') return openMenu(act, id);
    if (id === state.currentId) togglePlay(); else playFromView(id);
  });
  rows.addEventListener('keydown', e => {
    const row = e.target.closest('.row');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
  });
  rows.addEventListener('scroll', closeMenu, { passive: true });

  /* Menú contextual */
  $('#menu').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const id = $('#menu').dataset.id; closeMenu();
    if (b.dataset.m === 'add') addToList(b.dataset.list, id);
    else if (b.dataset.m === 'newlist') newList(id);
    else if (b.dataset.m === 'remove') removeFromList(id);
    else if (b.dataset.m === 'delete') deleteItem(id);
    else if (b.dataset.m === 'edit') editItem(id);
    else if (b.dataset.m === 'goalbum') { const it = state.items.get(id); if (it) setView('album', albumKey(it.album)); }
  });
  document.addEventListener('pointerdown', e => { if (!$('#menu').hidden && !e.target.closest('#menu')) closeMenu(); });
  addEventListener('resize', closeMenu);

  /* Reproductor */
  $('#playBtn').onclick = togglePlay;
  $('#prevBtn').onclick = prev;
  $('#nextBtn').onclick = () => step(1);
  $('#shuffleBtn').onclick = toggleShuffle;
  $('#repeatBtn').onclick = cycleRepeat;
  const seek = $('#seek');
  seek.addEventListener('pointerdown', () => { scrubbing = true; });
  addEventListener('pointerup', () => { scrubbing = false; });
  seek.addEventListener('input', () => {
    const d = audio.duration;
    if (isFinite(d)) audio.currentTime = (seek.value / 1000) * d;
    setRange(seek, +seek.value, 1000); $('#tCur').textContent = fmt(audio.currentTime);
  });
  $('#volume').addEventListener('input', e => { audio.muted = false; audio.volume = +e.target.value; updateVolume(); savePrefs(); });
  $('#muteBtn').onclick = () => { audio.muted = !audio.muted; updateVolume(); };
  $('#expandBtn').onclick = () => setExpanded(!state.expanded);
  $('.now').addEventListener('click', e => { if (!state.expanded && state.currentId && e.target.closest('.np-cover,.np-text')) setExpanded(true); });
  bindQueue(); bindSheet();

  audio.addEventListener('timeupdate', updateTimes);
  audio.addEventListener('durationchange', updateTimes);
  audio.addEventListener('loadedmetadata', () => {
    const it = state.items.get(state.currentId);
    if (it && !it.duration && isFinite(audio.duration)) { it.duration = audio.duration; DB.put('items', it).catch(() => {}); renderRows(); }
    updateTimes();
  });
  audio.addEventListener('play', () => { updatePlayIcon(); markPlaying(); });
  audio.addEventListener('pause', () => { updatePlayIcon(); markPlaying(); });
  audio.addEventListener('playing', () => { errorStreak = 0; });
  audio.addEventListener('ended', () => step(1, true));
  audio.addEventListener('error', async () => {
    if (!state.currentId || !audio.getAttribute('src')) return;
    if (!triedData) {                          // un reintento con una URL nueva (por si la anterior caducó)
      triedData = true;
      const id = state.currentId;
      try { const u = await DB.streamUrl(id); if (state.currentId === id) { await loadSource(u); return; } } catch (e) {}
    }
    const it = state.items.get(state.currentId);
    toast(`No se puede abrir «${it ? it.title : 'el archivo'}»`);
    if (++errorStreak <= 3 && state.order.length > 1) setTimeout(() => step(1, true), 600);
  });

  /* Controles del sistema (pantalla de bloqueo, teclas multimedia) */
  if ('mediaSession' in navigator) {
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) {} };
    set('play', () => audio.play().catch(() => {}));
    set('pause', () => audio.pause());
    set('previoustrack', prev);
    set('nexttrack', () => step(1));
    set('seekto', d => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
  }

  /* Arrastrar y soltar */
  let depth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; $('#drop').hidden = false; } });
  addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; $('#drop').hidden = true; } });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; $('#drop').hidden = true;
    importFiles(e.dataTransfer.files);
  });

  /* Atajos de teclado: Espacio, ← →, Shift+← →, ↑ ↓, M */
  addEventListener('keydown', e => {
    if (e.target.closest('input,select,textarea,dialog')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { if (!$('#menu').hidden) closeMenu(); else if (state.expanded) setExpanded(false); return; }
    if (e.key === ' ' && !e.target.closest('button,.row,.menu')) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? step(1) : (audio.currentTime += CONFIG.seekStepSec); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? prev() : (audio.currentTime -= CONFIG.seekStepSec); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); audio.volume = Math.min(1, audio.volume + CONFIG.volumeStep); updateVolume(); savePrefs(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); audio.volume = Math.max(0, audio.volume - CONFIG.volumeStep); updateVolume(); savePrefs(); }
    else if (e.key.toLowerCase() === 'm') { audio.muted = !audio.muted; updateVolume(); }
  });
}

/* ===================== 10. SESIÓN, SINCRONIZACIÓN E INICIO ===================== */
async function loadFromDB() {
  const [items, lists] = await Promise.all([DB.all('items'), DB.all('lists')]);
  state.items = new Map(items.map(i => [i.id, i]));
  state.lists = lists.sort((a, b) => a.created - b.created);
  if (state.view.type === 'list' && !getList(state.view.id)) state.view = { type: 'library', id: null };
}

/* Pantalla de entrada: se muestra una sola vez por dispositivo */
function showLogin() {
  return new Promise(res => {
    const dlg = $('#login'), form = $('#loginForm'), em = $('#loginEmail'), pw = $('#loginPass'), err = $('#loginErr'), btn = $('#loginOk');
    dlg.oncancel = e => e.preventDefault();          // no se puede cerrar sin entrar
    form.onsubmit = async e => {
      e.preventDefault();
      err.hidden = true; btn.disabled = true; btn.textContent = 'Entrando…';
      try {
        await Cloud.signIn(em.value.trim(), pw.value);
        pw.value = ''; dlg.close(); res();
      } catch (ex) {
        err.textContent = !ex.status ? 'Sin conexión. Inténtalo de nuevo.'
          : ex.status === 400 ? 'Correo o contraseña incorrectos.' : ex.message;
        err.hidden = false;
      } finally { btn.disabled = false; btn.textContent = 'Entrar'; }
    };
    if (!dlg.open) dlg.showModal();
    em.focus();
  });
}

async function runSync(silent) {
  if (!silent) toast('Sincronizando…', 0);
  const r = await DB.sync();
  if (r === 'busy') return;
  if (!Cloud.hasSession()) { $('#toast').hidden = true; await showLogin(); return runSync(silent); }
  if (r === 'ok') {
    await loadFromDB(); buildSortOptions(); renderNav(); renderMain();
    if (!silent) $('#toast').hidden = true;
  } else if (!silent) toast('Sin conexión: se muestra la copia guardada en este dispositivo', 4000);
}

async function logout() {
  const n = DB.pending();
  const ok = await ask({
    title: 'Cerrar sesión',
    text: 'Se quitará de este dispositivo la copia de tu biblioteca. Tus canciones siguen guardadas en la nube.' +
      (n ? ` Ojo: hay ${n} cambio${n === 1 ? '' : 's'} sin subir que se perderían.` : ''),
    ok: 'Cerrar sesión',
  });
  if (!ok) return;
  stopPlayback();
  await DB.wipe();
  Cloud.signOut();
  location.reload();
}

/* ============================ 11. INIT ============================= */
(async function init() {
  const persistent = await DB.init();

  /* 1. Sesión: si no hay (o ya no vale), se pide entrar */
  if (!Cloud.hasSession()) await showLogin();
  else { try { await Cloud.token(); } catch (e) { if (e.status) await showLogin(); /* sin status = sin conexión: se usa la copia local */ } }

  /* 2. Se muestra al instante lo que ya hay en este dispositivo */
  await loadFromDB();
  const prefs = await DB.get('settings', 'prefs');
  audio.volume = prefs?.volume ?? CONFIG.defaultVolume;
  state.shuffle = !!prefs?.shuffle;
  state.repeat = prefs?.repeat || 'off';

  try { setHeadCollapsed(localStorage.getItem('orpheus-head') === '1', false); } catch (e) {}
  bindEvents();
  buildSortOptions(); renderNav(); renderMain();
  updateNowPlaying(); updateModes(); updateVolume(); updateTimes();

  if (!persistent) toast('El guardado local no está disponible: se usará solo la nube mientras la página esté abierta', 6000);
  else if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* 3. Se sincroniza con la nube ahora, al volver la conexión y al volver a la pestaña */
  addEventListener('online', () => runSync(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - DB.lastSync() > 60000) runSync(true);
  });
  runSync(false);
})();
