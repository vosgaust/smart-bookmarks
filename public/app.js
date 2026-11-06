'use strict';

/* =========================================================
   Smart Bookmarks
   Modelo:  { spaces: { personal: Item[], trabajo: Item[] }, settings: { newTab } }
   Item  =  { id, type: 'link',   title, url }
         |  { id, type: 'folder', title, children: Item[] }
   ========================================================= */

const STORAGE_KEY = 'smart-bookmarks:v1';
const DND_TYPE = 'application/x-smart-bookmark';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'ftp:', 'mailto:']);

// Espacios: cada uno tiene sus propios bookmarks. El espacio activo se recuerda por dispositivo.
const SPACE_KEY = 'smart-bookmarks:space';
const SPACES = [
  { id: 'personal', label: 'Personal', icon: '<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/></svg>' },
  { id: 'trabajo', label: 'Trabajo', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M3 13h18"/></svg>' },
];
const isSpace = (id) => SPACES.some((s) => s.id === id);

const $ = (sel) => document.querySelector(sel);
const els = {
  today: $('#today'),
  form: $('#addForm'),
  input: $('#addInput'),
  hint: $('#addHint'),
  newFolder: $('#newFolderBtn'),
  crumbs: $('#crumbs'),
  board: $('#board'),
  grid: $('#grid'),
  empty: $('#empty'),
  dialog: $('#editDialog'),
  editForm: $('#editForm'),
  editHeading: $('#editHeading'),
  fTitle: $('#fTitle'),
  fUrl: $('#fUrl'),
  urlRow: $('#urlRow'),
  cancelEdit: $('#cancelEdit'),
  newTab: $('#newTab'),
  exportBtn: $('#exportBtn'),
  importBtn: $('#importBtn'),
  importFile: $('#importFile'),
  toast: $('#toast'),
  toastMsg: $('#toastMsg'),
  toastUndo: $('#toastUndo'),
  syncStatus: $('#syncStatus'),
  spaces: $('#spaces'),
};

const ICONS = {
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  delete: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

/* ---------------- State ---------------- */

let state;              // se carga en Init, al final del archivo
let space = initialSpace();
let path = [];          // ids de carpetas desde la raíz del espacio hasta la carpeta abierta
let drag = null;        // { id } mientras se arrastra un bookmark propio
let dropTarget = null;  // { mode: 'before'|'after'|'into'|'end', id? }
let editing = null;     // { mode: 'edit', id } | { mode: 'new-folder' }

function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
const makeLink = (title, url) => ({ id: uid(), type: 'link', title, url });
const makeFolder = (title, children = []) => ({ id: uid(), type: 'folder', title, children });

function defaults() {
  return [
    makeLink('Google', 'https://www.google.com'),
    makeLink('Gmail', 'https://mail.google.com'),
    makeLink('YouTube', 'https://www.youtube.com'),
    makeLink('GitHub', 'https://github.com'),
    makeFolder('Lectura', [
      makeLink('Hacker News', 'https://news.ycombinator.com'),
      makeLink('Wikipedia', 'https://es.wikipedia.org'),
      makeLink('El País', 'https://elpais.com'),
    ]),
  ];
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && (data.spaces || Array.isArray(data.items))) return normalizeState(data);
    }
  } catch { /* datos corruptos o storage bloqueado: empezamos de cero */ }
  return normalizeState({ spaces: { personal: defaults() } });
}

// Acepta el formato con espacios y el antiguo ({ items }), que pasa a "personal".
function normalizeState(data) {
  const src = data.spaces && typeof data.spaces === 'object' ? data.spaces : { personal: data.items };
  const spaces = {};
  for (const { id } of SPACES) spaces[id] = sanitize(src[id]);
  for (const [id, items] of Object.entries(src)) {
    if (!(id in spaces) && /^[a-z0-9_-]{1,32}$/.test(id)) spaces[id] = sanitize(items); // no perder espacios desconocidos
  }
  return { spaces, settings: { newTab: false, ...(data.settings || {}) } };
}

function initialSpace() {
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (isSpace(fromHash)) return fromHash;
  try {
    const saved = localStorage.getItem(SPACE_KEY);
    if (isSpace(saved)) return saved;
  } catch { /* ignorar */ }
  return SPACES[0].id;
}

const rootItems = () => state.spaces[space];
const spaceLabel = (id) => SPACES.find((s) => s.id === id)?.label || id;
const countAll = () => Object.values(state.spaces).reduce((n, list) => n + countLinks(list), 0);

// Limpia datos importados: ids, tipos y URLs válidas.
function sanitize(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'folder' || Array.isArray(it.children)) {
      out.push({ id: String(it.id || uid()), type: 'folder', title: String(it.title || 'Carpeta'), children: sanitize(it.children) });
    } else {
      const url = normalizeUrl(String(it.url || ''));
      if (url) out.push({ id: String(it.id || uid()), type: 'link', title: String(it.title || titleFromUrl(url)), url });
    }
  }
  return out;
}

// Copia local (caché): la página carga al instante y funciona sin conexión.
function writeCache() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(SYNC_KEY, JSON.stringify({ version: sync.version, dirty: sync.dirty }));
  } catch { /* storage bloqueado: seguimos solo en memoria / servidor */ }
}

function readSyncMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(SYNC_KEY) || '{}');
    return { version: Number.isInteger(m.version) ? m.version : 0, dirty: !!m.dirty };
  } catch {
    return { version: 0, dirty: false };
  }
}

function save() {
  if (sync.mode === 'server') {
    sync.dirty = true;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(push, 400);
    setSyncStatus('saving');
  }
  writeCache();
}

function commit() {
  save();
  render();
}

/* ---------------- Sincronización con el servidor ----------------
   El servidor guarda el árbol completo con un número de versión.
   Al guardar enviamos la versión de la que partimos; si otro dispositivo
   guardó antes, el servidor responde 409 y cargamos su versión. */

const API = 'api/bookmarks';
const SYNC_KEY = 'smart-bookmarks:sync';
const POLL_MS = 20000;
const sync = {
  mode: location.protocol.startsWith('http') ? 'server' : 'local', // pasa a 'local' si no hay API
  version: 0,
  dirty: false,      // hay cambios locales sin subir
  inflight: false,
  again: false,
  timer: null,
};

const SYNC_LABELS = {
  local: 'Guardado en este navegador',
  saving: 'Guardando…',
  synced: 'Sincronizado',
  offline: 'Sin conexión · los cambios se subirán al volver',
  error: 'Error al guardar',
};
function setSyncStatus(status, detail = '') {
  els.syncStatus.dataset.status = status;
  els.syncStatus.textContent = SYNC_LABELS[status];
  els.syncStatus.title = detail || SYNC_LABELS[status];
}

async function apiGet(query = '') {
  const res = await fetch(API + query, { cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

function applyRemote(remote) {
  state = normalizeState(remote);
  sync.version = remote.version;
  sync.dirty = false;
  writeCache();
  render();
  setSyncStatus('synced');
}

// Decide qué hacer con lo que hay en el servidor frente a lo que hay en este navegador.
function reconcile(remote) {
  if (remote.version === 0) {
    // Servidor recién creado: le subimos lo que tengamos aquí.
    sync.version = 0;
    save();
    return;
  }
  if (sync.dirty && remote.version === sync.version) {
    push(); // cambios hechos sin conexión y nadie más ha tocado nada
    return;
  }
  if (sync.dirty) toast('Había cambios desde otro dispositivo: se ha cargado la versión del servidor');
  applyRemote(remote);
}

async function push() {
  if (sync.mode !== 'server' || !sync.dirty) return;
  if (sync.inflight) {
    sync.again = true;
    return;
  }
  clearTimeout(sync.timer);
  sync.inflight = true;
  sync.dirty = false; // si cambia algo durante la petición, save() lo vuelve a marcar
  setSyncStatus('saving');
  try {
    const res = await fetch(API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaces: state.spaces, settings: state.settings, version: sync.version }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.state) {
      toast('Se guardó algo desde otro dispositivo: se ha cargado esa versión y tu último cambio no se aplicó');
      sync.again = false;
      applyRemote(data.state);
    } else if (!res.ok) {
      sync.dirty = true;
      setSyncStatus('error', data.error || `HTTP ${res.status}`);
    } else {
      sync.version = data.version;
      setSyncStatus(sync.dirty ? 'saving' : 'synced');
    }
  } catch {
    sync.dirty = true;
    setSyncStatus('offline');
  } finally {
    sync.inflight = false;
    writeCache();
    if (sync.again) {
      sync.again = false;
      push();
    }
  }
}

async function poll() {
  if (sync.mode !== 'server' || document.hidden || sync.inflight) return;
  if (sync.dirty) return push();
  try {
    const data = await apiGet(`?since=${sync.version}`);
    if (data.changed === false) return setSyncStatus('synced');
    // No repintar en mitad de un arrastre o con el diálogo abierto: se aplicará en el siguiente ciclo.
    if (drag || els.dialog.open || sync.dirty || sync.inflight) return;
    reconcile(data);
  } catch {
    setSyncStatus('offline');
  }
}

async function initSync() {
  if (sync.mode !== 'server') return setSyncStatus('local');
  Object.assign(sync, readSyncMeta());
  try {
    reconcile(await apiGet());
  } catch (err) {
    if (err.status === 404) {
      // Servido sin la API (p. ej. un servidor de archivos estáticos): modo solo-local.
      sync.mode = 'local';
      return setSyncStatus('local');
    }
    setSyncStatus('offline');
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('online', poll);
}

/* ---------------- Tree helpers ---------------- */

function find(id, list = rootItems()) {
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item.id === id) return { item, list, index: i };
    if (item.type === 'folder') {
      const hit = find(id, item.children);
      if (hit) return hit;
    }
  }
  return null;
}

function detach(id) {
  const hit = find(id);
  if (!hit) return null;
  hit.list.splice(hit.index, 1);
  return hit.item;
}

function contains(folder, id) {
  return folder.type === 'folder' && folder.children.some((c) => c.id === id || contains(c, id));
}

function countLinks(list) {
  return list.reduce((n, it) => n + (it.type === 'folder' ? countLinks(it.children) : 1), 0);
}

// Devuelve la lista de la carpeta abierta y la "miga de pan" de carpetas.
function currentFolder(depth = path.length) {
  let list = rootItems();
  const trail = [];
  for (const id of path.slice(0, depth)) {
    const folder = list.find((x) => x.id === id && x.type === 'folder');
    if (!folder) {
      path = trail.map((f) => f.id); // la carpeta ya no existe
      break;
    }
    trail.push(folder);
    list = folder.children;
  }
  return { list, trail };
}

/* ---------------- URL helpers ---------------- */

function looksLikeUrl(s) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
    || /^mailto:/i.test(s)
    || /^localhost(:\d+)?(\/|$)/i.test(s)
    || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)
    || /^[^\s/@]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(s);
}

function normalizeUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    const local = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/|$)/i.test(s);
    s = (local ? 'http://' : 'https://') + s;
  }
  try {
    const u = new URL(s);
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return null;
    return u.href;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function titleFromUrl(url) {
  const host = hostOf(url);
  if (!host) return url;
  if (/^[\d.]+$/.test(host) || host === 'localhost') return host;
  const parts = host.split('.');
  let name = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  // bbc.co.uk, google.com.ar …
  if (parts.length > 2 && name.length <= 3 && ['co', 'com', 'org', 'net', 'gov', 'gob', 'edu', 'ac'].includes(name)) {
    name = parts[parts.length - 3];
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// "Nombre opcional  url"  (o "url  nombre")
function parseInput(text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const urlIdx = tokens.findIndex(looksLikeUrl);
  if (urlIdx === -1) return null;
  const url = normalizeUrl(tokens[urlIdx]);
  if (!url) return null;
  const title = tokens.filter((_, i) => i !== urlIdx).join(' ') || titleFromUrl(url);
  return { title, url };
}

function faviconUrl(url) {
  const host = hostOf(url);
  if (!host || host === 'localhost' || /^[\d.]+$/.test(host)) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

function hueOf(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- Rendering ---------------- */

function render() {
  const { list, trail } = currentFolder();

  // Migas de pan (solo dentro de una carpeta)
  els.crumbs.hidden = trail.length === 0;
  els.crumbs.replaceChildren();
  const crumbs = [{ title: 'Inicio' }, ...trail];
  crumbs.forEach((c, depth) => {
    if (depth) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      els.crumbs.append(sep);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'crumb';
    b.textContent = c.title;
    b.dataset.depth = depth;
    if (depth === crumbs.length - 1) b.setAttribute('aria-current', 'page');
    els.crumbs.append(b);
  });

  els.grid.replaceChildren(...list.map(tileFor));
  els.empty.hidden = list.length > 0;
  els.newTab.checked = !!state.settings.newTab;
  renderSpaces();
  const where = trail.length ? trail[trail.length - 1].title : spaceLabel(space);
  document.title = `${where} · Bookmarks`;
}

function iconHtml(url, title) {
  const host = hostOf(url) || title;
  const fav = faviconUrl(url);
  const letter = esc((title || host || '?').trim().charAt(0).toUpperCase());
  return `<span class="icon${fav ? '' : ' no-img'}" style="--hue:${hueOf(host)}">${letter}${
    fav ? `<img src="${esc(fav)}" alt="" draggable="false" loading="lazy">` : ''}</span>`;
}

function folderPreview(folder) {
  const links = folder.children.filter((c) => c.type === 'link').slice(0, 4);
  if (!folder.children.length) return `<span class="folder-icon empty-folder">${ICONS.folder}</span>`;
  const minis = links.map((l) => {
    const fav = faviconUrl(l.url);
    return fav
      ? `<img src="${esc(fav)}" alt="" draggable="false" loading="lazy">`
      : `<span class="mini" style="--hue:${hueOf(hostOf(l.url))}"></span>`;
  });
  const subfolders = folder.children.length - links.length;
  while (minis.length < 4 && minis.length < links.length + subfolders) minis.push(`<span class="mini" style="--hue:220"></span>`);
  return `<span class="folder-icon">${minis.join('')}</span>`;
}

function tileFor(item) {
  const el = document.createElement('div');
  el.className = 'tile' + (item.type === 'folder' ? ' is-folder' : '');
  el.draggable = true;
  el.dataset.id = item.id;

  const actions = `<div class="tile-actions">
      <button type="button" data-act="edit" title="Editar" aria-label="Editar ${esc(item.title)}">${ICONS.edit}</button>
      <button type="button" data-act="delete" title="Eliminar" aria-label="Eliminar ${esc(item.title)}">${ICONS.delete}</button>
    </div>`;

  if (item.type === 'link') {
    const target = state.settings.newTab ? ' target="_blank" rel="noopener"' : '';
    el.innerHTML = `<a class="tile-main" href="${esc(item.url)}" draggable="false" title="${esc(item.url)}"${target}>
        ${iconHtml(item.url, item.title)}
        <span class="tile-title">${esc(item.title)}</span>
        <span class="tile-sub">${esc(hostOf(item.url) || item.url)}</span>
      </a>${actions}`;
  } else {
    const n = item.children.length;
    el.innerHTML = `<button type="button" class="tile-main" draggable="false" title="Abrir carpeta">
        ${folderPreview(item)}
        <span class="tile-title">${esc(item.title)}</span>
        <span class="tile-sub">${n === 1 ? '1 elemento' : `${n} elementos`}</span>
      </button>${actions}`;
  }
  return el;
}

// Favicons: si no carga, mostramos la inicial con color.
els.grid.addEventListener('error', (e) => {
  if (e.target.tagName !== 'IMG') return;
  const icon = e.target.closest('.icon');
  if (icon) icon.classList.add('no-img');
  e.target.remove();
}, true);

/* ---------------- Quick add ---------------- */

let hintTimer;
function flashHint(msg, kind = 'info') {
  els.hint.textContent = msg;
  els.hint.dataset.kind = kind;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { els.hint.textContent = ''; }, 3500);
}

function highlight(id) {
  const tile = els.grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!tile) return;
  tile.classList.add('just-added');
  tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setTimeout(() => tile.classList.remove('just-added'), 1200);
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const parsed = parseInput(els.input.value);
  if (!parsed) {
    if (els.input.value.trim()) {
      flashHint('Eso no parece una URL. Prueba con algo como «github.com» o «Mi app https://…».', 'error');
      els.form.classList.remove('shake');
      void els.form.offsetWidth;
      els.form.classList.add('shake');
    }
    return;
  }
  const item = makeLink(parsed.title, parsed.url);
  currentFolder().list.push(item);
  els.input.value = '';
  commit();
  highlight(item.id);
  const dup = countDuplicates(parsed.url);
  flashHint(dup > 1 ? `Añadido «${item.title}» (ya lo tenías guardado en otro sitio)` : `Añadido «${item.title}»`);
});
els.form.addEventListener('animationend', () => els.form.classList.remove('shake'));

function countDuplicates(url, list = rootItems()) {
  return list.reduce((n, it) => n + (it.type === 'folder' ? countDuplicates(url, it.children) : it.url === url ? 1 : 0), 0);
}

/* ---------------- Grid clicks ---------------- */

els.grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const id = tile.dataset.id;
  const act = e.target.closest('[data-act]');
  if (act) {
    e.preventDefault();
    if (act.dataset.act === 'edit') openEdit(id);
    else removeItem(id);
    return;
  }
  const hit = find(id);
  if (hit?.item.type === 'folder' && e.target.closest('.tile-main')) {
    path.push(id);
    render();
  }
});

els.crumbs.addEventListener('click', (e) => {
  const c = e.target.closest('.crumb');
  if (!c || c.hasAttribute('aria-current')) return;
  path = path.slice(0, Number(c.dataset.depth));
  render();
});

/* ---------------- Edit / new folder dialog ---------------- */

function openEdit(id) {
  const hit = find(id);
  if (!hit) return;
  const { item } = hit;
  editing = { mode: 'edit', id };
  els.editHeading.textContent = item.type === 'link' ? 'Editar bookmark' : 'Editar carpeta';
  els.fTitle.value = item.title;
  els.urlRow.hidden = item.type !== 'link';
  els.fUrl.value = item.type === 'link' ? item.url : '';
  els.fUrl.setCustomValidity('');
  els.dialog.showModal();
  els.fTitle.select();
}

function openNewFolder() {
  editing = { mode: 'new-folder' };
  els.editHeading.textContent = 'Nueva carpeta';
  els.fTitle.value = '';
  els.urlRow.hidden = true;
  els.dialog.showModal();
  els.fTitle.focus();
}

els.newFolder.addEventListener('click', openNewFolder);
els.cancelEdit.addEventListener('click', () => els.dialog.close());
els.fUrl.addEventListener('input', () => els.fUrl.setCustomValidity(''));

els.editForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = els.fTitle.value.trim();
  if (!title) {
    els.fTitle.reportValidity();
    return;
  }
  if (editing?.mode === 'new-folder') {
    const folder = makeFolder(title);
    currentFolder().list.push(folder);
    els.dialog.close();
    commit();
    highlight(folder.id);
    return;
  }
  const hit = editing && find(editing.id);
  if (!hit) return els.dialog.close();
  if (hit.item.type === 'link') {
    const url = normalizeUrl(els.fUrl.value);
    if (!url) {
      els.fUrl.setCustomValidity('Introduce una URL válida');
      els.fUrl.reportValidity();
      return;
    }
    hit.item.url = url;
  }
  hit.item.title = title;
  els.dialog.close();
  commit();
});

/* ---------------- Delete + undo ---------------- */

function removeItem(id) {
  const snapshotSpace = space;
  const snapshot = JSON.stringify(rootItems());
  const item = detach(id);
  if (!item) return;
  commit();
  const extra = item.type === 'folder' && item.children.length ? ` y su contenido` : '';
  toast(`«${item.title}»${extra} eliminado`, () => {
    state.spaces[snapshotSpace] = JSON.parse(snapshot);
    commit();
  });
}

let toastTimer;
let toastUndoFn = null;
function toast(msg, undoFn = null) {
  els.toastMsg.textContent = msg;
  toastUndoFn = undoFn;
  els.toastUndo.hidden = !undoFn;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; toastUndoFn = null; }, 6000);
}
els.toastUndo.addEventListener('click', () => {
  if (toastUndoFn) toastUndoFn();
  toastUndoFn = null;
  els.toast.hidden = true;
});

/* ---------------- Drag & drop ---------------- */

function accepts(e) {
  if (drag) return true;
  const types = Array.from(e.dataTransfer?.types || []);
  return types.includes('text/uri-list') || types.includes('text/plain');
}

function clearDrop() {
  els.grid.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((t) => t.classList.remove('drop-before', 'drop-after', 'drop-into'));
  els.board.classList.remove('drop-end');
  dropTarget = null;
}

function setDrop(t) {
  const same = (a, b) => a === b || (a && b && a.mode === b.mode && a.id === b.id);
  if (same(t, dropTarget)) return;
  clearDrop();
  dropTarget = t;
  if (!t) return;
  if (t.mode === 'end') {
    els.board.classList.add('drop-end');
    return;
  }
  const tile = els.grid.querySelector(`[data-id="${CSS.escape(t.id)}"]`);
  tile?.classList.add(`drop-${t.mode}`);
}

els.grid.addEventListener('dragstart', (e) => {
  const tile = e.target.closest?.('.tile');
  if (!tile) return;
  const hit = find(tile.dataset.id);
  if (!hit) return;
  drag = { id: tile.dataset.id };
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData(DND_TYPE, drag.id);
  if (hit.item.type === 'link') {
    // permite soltarlo también en otras apps / pestañas
    e.dataTransfer.setData('text/uri-list', hit.item.url);
    e.dataTransfer.setData('text/plain', hit.item.url);
  }
  document.body.classList.add('dragging');
  requestAnimationFrame(() => tile.classList.add('is-dragging'));
});

els.grid.addEventListener('dragend', () => {
  drag = null;
  clearDrop();
  document.body.classList.remove('dragging');
  els.grid.querySelectorAll('.is-dragging').forEach((t) => t.classList.remove('is-dragging'));
  document.querySelectorAll('.crumb.drop-into, .spaces .drop-into').forEach((c) => c.classList.remove('drop-into'));
});

els.board.addEventListener('dragover', (e) => {
  if (!accepts(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = drag ? 'move' : 'copy';

  const tile = e.target.closest('.tile');
  if (!tile) {
    setDrop({ mode: 'end' });
    return;
  }
  const id = tile.dataset.id;
  if (drag && id === drag.id) {
    setDrop(null);
    return;
  }
  const r = tile.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  if (tile.classList.contains('is-folder') && x > 0.22 && x < 0.78) {
    setDrop({ mode: 'into', id });
  } else {
    setDrop({ mode: x < 0.5 ? 'before' : 'after', id });
  }
});

els.board.addEventListener('dragleave', (e) => {
  if (!els.board.contains(e.relatedTarget)) clearDrop();
});

els.board.addEventListener('drop', (e) => {
  if (!accepts(e)) return;
  e.preventDefault();
  const target = dropTarget;
  clearDrop();
  if (drag && !target) return; // soltado sobre sí mismo

  const { list } = currentFolder();
  let item;
  if (drag) {
    item = detach(drag.id);
  } else {
    item = linkFromDataTransfer(e.dataTransfer);
    if (!item) {
      flashHint('No he encontrado una URL en lo que has soltado.', 'error');
      return;
    }
  }
  if (!item) return;
  place(item, list, target);
  commit();
  if (!drag) highlight(item.id);
});

function place(item, list, target) {
  const idx = target?.id ? list.findIndex((x) => x.id === target.id) : -1;
  if (!target || target.mode === 'end' || idx === -1) {
    list.push(item);
  } else if (target.mode === 'into') {
    const folder = list[idx];
    if (folder.type === 'folder' && folder !== item && !contains(item, folder.id)) folder.children.push(item);
    else list.push(item);
  } else {
    list.splice(target.mode === 'before' ? idx : idx + 1, 0, item);
  }
}

function linkFromDataTransfer(dt) {
  const uriList = dt.getData('text/uri-list');
  const plain = dt.getData('text/plain');
  const rawUrl = (uriList.split(/\r?\n/).find((l) => l && !l.startsWith('#')) || plain || '').trim();
  const url = looksLikeUrl(rawUrl) ? normalizeUrl(rawUrl) : null;
  if (!url) return null;
  let title = '';
  const html = dt.getData('text/html');
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    title = (doc.querySelector('a')?.textContent || '').trim().replace(/\s+/g, ' ');
  }
  if (!title || title === rawUrl || title.length > 80) title = titleFromUrl(url);
  return makeLink(title, url);
}

// Migas de pan como destino: sacar un bookmark de la carpeta actual
els.crumbs.addEventListener('dragover', (e) => {
  const c = e.target.closest('.crumb');
  if (!drag || !c || c.hasAttribute('aria-current')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  els.crumbs.querySelectorAll('.drop-into').forEach((x) => x !== c && x.classList.remove('drop-into'));
  c.classList.add('drop-into');
});
els.crumbs.addEventListener('dragleave', (e) => {
  const c = e.target.closest('.crumb');
  if (c && !c.contains(e.relatedTarget)) c.classList.remove('drop-into');
});
els.crumbs.addEventListener('drop', (e) => {
  const c = e.target.closest('.crumb');
  if (!drag || !c) return;
  e.preventDefault();
  c.classList.remove('drop-into');
  const depth = Number(c.dataset.depth);
  const item = detach(drag.id);
  if (!item) return;
  currentFolder(depth).list.push(item);
  commit();
  flashHint(`«${item.title}» movido a ${c.textContent}`);
});

/* ---------------- Espacios (personal / trabajo) ---------------- */

function renderSpaces() {
  document.documentElement.dataset.space = space;
  if (!els.spaces.children.length) {
    els.spaces.innerHTML = SPACES.map((s) =>
      `<button type="button" role="tab" data-space="${s.id}" title="${esc(s.label)} — suelta aquí un bookmark para moverlo a este espacio">${s.icon}<span>${esc(s.label)}</span></button>`
    ).join('');
  }
  for (const b of els.spaces.children) {
    const active = b.dataset.space === space;
    b.setAttribute('aria-selected', String(active));
    b.tabIndex = active ? 0 : -1;
  }
}

function switchSpace(id) {
  if (!isSpace(id) || id === space) return;
  space = id;
  path = [];
  try { localStorage.setItem(SPACE_KEY, id); } catch { /* ignorar */ }
  history.replaceState(null, '', `#${id}`);
  render();
}

els.spaces.addEventListener('click', (e) => {
  const b = e.target.closest('[data-space]');
  if (b) switchSpace(b.dataset.space);
});

// Flechas izquierda/derecha para cambiar de espacio cuando el selector tiene el foco
els.spaces.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const i = SPACES.findIndex((s) => s.id === space);
  const next = SPACES[(i + (e.key === 'ArrowRight' ? 1 : SPACES.length - 1)) % SPACES.length];
  switchSpace(next.id);
  els.spaces.querySelector(`[data-space="${next.id}"]`)?.focus();
});

window.addEventListener('hashchange', () => switchSpace(decodeURIComponent(location.hash.slice(1))));

// Soltar un bookmark sobre el otro espacio lo mueve allí
els.spaces.addEventListener('dragover', (e) => {
  const b = e.target.closest('[data-space]');
  if (!drag || !b || b.dataset.space === space) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  b.classList.add('drop-into');
});
els.spaces.addEventListener('dragleave', (e) => {
  const b = e.target.closest('[data-space]');
  if (b && !b.contains(e.relatedTarget)) b.classList.remove('drop-into');
});
els.spaces.addEventListener('drop', (e) => {
  const b = e.target.closest('[data-space]');
  if (!drag || !b || b.dataset.space === space) return;
  e.preventDefault();
  b.classList.remove('drop-into');
  const item = detach(drag.id);
  if (!item) return;
  state.spaces[b.dataset.space].push(item);
  commit();
  flashHint(`«${item.title}» movido a ${spaceLabel(b.dataset.space)}`);
});

/* ---------------- Settings, export & import ---------------- */

els.newTab.addEventListener('change', () => {
  state.settings.newTab = els.newTab.checked;
  commit();
});

els.exportBtn.addEventListener('click', () => {
  const data = { app: 'smart-bookmarks', version: 1, exportedAt: new Date().toISOString(), ...state };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

els.importBtn.addEventListener('click', () => els.importFile.click());

els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files[0];
  els.importFile.value = '';
  if (!file) return;
  const text = await file.text();
  const snapshot = JSON.stringify(state);
  const undo = () => { state = JSON.parse(snapshot); path = []; commit(); };

  if (/\.json$/i.test(file.name) || text.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(text);
      if (data.spaces && typeof data.spaces === 'object') {
        state = normalizeState(data); // copia completa: todos los espacios
        toast(`Copia restaurada: ${countAll()} bookmarks`, undo);
      } else if (Array.isArray(data.items)) {
        state.spaces[space] = sanitize(data.items); // copia antigua: solo el espacio actual
        toast(`Copia restaurada en ${spaceLabel(space)}: ${countLinks(rootItems())} bookmarks`, undo);
      } else {
        throw new Error('formato desconocido');
      }
      path = [];
      commit();
    } catch {
      toast('Ese archivo JSON no es una copia válida de Bookmarks');
    }
    return;
  }

  const items = parseNetscapeBookmarks(text);
  const n = countLinks(items);
  if (!n) {
    toast('No he encontrado marcadores en ese archivo');
    return;
  }
  const folder = makeFolder(`Importados ${new Date().toLocaleDateString('es-ES')}`, items);
  currentFolder().list.push(folder);
  commit();
  highlight(folder.id);
  toast(`${n} marcadores importados en «${folder.title}»`, undo);
});

// Formato HTML que exportan Chrome, Firefox, Safari y Edge.
function parseNetscapeBookmarks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.querySelector('dl');
  if (!root) return [];
  const walk = (dl) => {
    const out = [];
    for (const dt of dl.children) {
      if (dt.tagName !== 'DT') continue;
      const a = dt.querySelector(':scope > a');
      const h3 = dt.querySelector(':scope > h3');
      if (a) {
        const url = normalizeUrl(a.getAttribute('href') || '');
        if (url) out.push(makeLink(a.textContent.trim() || titleFromUrl(url), url));
      } else if (h3) {
        const sub = dt.querySelector(':scope > dl');
        out.push(makeFolder(h3.textContent.trim() || 'Carpeta', sub ? walk(sub) : []));
      }
    }
    return out;
  };
  return walk(root);
}

/* ---------------- Keyboard ---------------- */

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, [contenteditable]') || els.dialog.open;
  if (e.key === '/' && !typing) {
    e.preventDefault();
    els.input.focus();
  } else if (e.key === 'Escape' && e.target === els.input && els.input.value) {
    els.input.value = '';
  } else if (e.key === 'Escape' && !els.dialog.open && path.length) {
    path.pop();
    render();
  }
});

// Sincroniza si tienes la página abierta en varias pestañas del mismo navegador
window.addEventListener('storage', (e) => {
  if (e.key === SYNC_KEY) {
    Object.assign(sync, readSyncMeta());
    return;
  }
  if (e.key !== STORAGE_KEY || !e.newValue || drag) return;
  try {
    state = normalizeState(JSON.parse(e.newValue));
    render();
  } catch { /* ignorar */ }
});

/* ---------------- Init ---------------- */

state = load();
initSync();
const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
els.today.textContent = today.charAt(0).toUpperCase() + today.slice(1);
render();
