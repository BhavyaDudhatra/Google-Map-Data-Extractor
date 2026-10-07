/* Maps Scraper Pro - popup controller */
import { areaSummary, EXPORT_COLUMNS } from './lib/merge.js';

const $ = (id) => document.getElementById(id);
const S_JOB = 'job', S_STATE = 'state', S_CFG = 'config', S_DATA = 'areaData';

const MAX_AREAS = 1000;
const DEFAULT_CFG = {
  delayBetweenAreas: 6,
  maxScrollSeconds: 75,
  stableRounds: 4,
  startDelaySeconds: 8,
  dedupe: true,
  stopOnBlocked: true,
  mapsUrl: 'https://www.google.com/maps/'
};

const STATUS_CLASS = {
  idle: 'idle', running: 'running', paused: 'paused',
  done: 'done', stopped: 'done', error: 'error'
};
const STATUS_TEXT = {
  idle: 'Idle', running: 'Running', paused: 'Paused',
  done: 'Complete', stopped: 'Stopped', error: 'Error'
};
const DOT_CLASS = {
  pending: '', running: 'running', done: 'done', empty: 'empty',
  error: 'error', skipped: 'skipped'
};

let cfg = { ...DEFAULT_CFG };
let lastState = null;
let exportCache = null;
let ticking = false;

/* ------------------------------------------------------------------ *
 * setup
 * ------------------------------------------------------------------ */
function parseAreas() {
  const raw = $('areas').value.split(/\r?\n/);
  const seen = new Set();
  const out = [];
  for (const line of raw) {
    const name = line.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

function validate() {
  const areas = parseAreas();
  const profession = $('profession').value.trim();
  const counter = $('areaCounter');
  const hint = $('areaHint');

  const okCount = areas.length >= 1 && areas.length <= MAX_AREAS;
  counter.textContent = `${areas.length} / ${MAX_AREAS}`;
  counter.classList.toggle('bad', !okCount);
  hint.classList.remove('bad');
  hint.textContent = areas.length === 0 ? 'Enter at least 1 area'
    : areas.length > MAX_AREAS ? `Too many - max ${MAX_AREAS}`
    : `${areas.length === 1 ? '1 area' : 'areas'} ready`;

  const pv = $('preview');
  if (areas.length && profession) {
    const first = `<b>${esc(profession)}</b> in <b>${esc(areas[0])}</b>`;
    pv.innerHTML = areas.length > 1
      ? `Query: ${first}<br>&hellip; then ${areas.length - 1} more area${areas.length > 2 ? 's' : ''}`
      : `Query: ${first}`;
  } else {
    pv.textContent = 'Query: <profession> in <area>';
  }

  const busy = lastState && (lastState.status === 'running' || lastState.status === 'stopping');
  const ready = areas.length >= 1 && areas.length <= MAX_AREAS && profession.length > 0 && !busy;
  $('startBtn').disabled = !ready;
  setStartLabel(areas.length > MAX_AREAS
    ? `Too many areas (${areas.length}/${MAX_AREAS})`
    : busy ? 'Scraping…' : `Start scraping (${areas.length} area${areas.length === 1 ? '' : 's'})`);
  return { areas, profession, ok: ready };
}

/* The start button carries an icon, so its text lives in a child span -
   writing textContent on the button itself would wipe the icon. */
function setStartLabel(text) {
  const lbl = $('startBtnLabel');
  if (lbl) lbl.textContent = text;
  else $('startBtn').textContent = text;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function readCfg() {
  cfg = {
    delayBetweenAreas: clampNum($('delayBetweenAreas').value, 0, 120, DEFAULT_CFG.delayBetweenAreas),
    maxScrollSeconds: clampNum($('maxScrollSeconds').value, 15, 600, DEFAULT_CFG.maxScrollSeconds),
    stableRounds: clampNum($('stableRounds').value, 2, 30, DEFAULT_CFG.stableRounds),
    startDelaySeconds: clampNum($('startDelaySeconds').value, 0, 120, DEFAULT_CFG.startDelaySeconds),
    dedupe: $('dedupe').checked,
    stopOnBlocked: $('stopOnBlocked').checked,
    mapsUrl: ($('mapsUrl').value.trim() || DEFAULT_CFG.mapsUrl).replace(/\/?$/, '/')
  };
  return cfg;
}

function writeCfg() {
  for (const k of ['delayBetweenAreas', 'maxScrollSeconds', 'stableRounds', 'startDelaySeconds']) $(k).value = cfg[k];
  $('dedupe').checked = cfg.dedupe;
  $('stopOnBlocked').checked = cfg.stopOnBlocked;
  $('mapsUrl').value = cfg.mapsUrl;
  chrome.storage.local.set({ [S_CFG]: cfg });
}

function clampNum(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function fillDefaults() {
  for (const k of ['delayBetweenAreas', 'maxScrollSeconds', 'stableRounds', 'startDelaySeconds']) $(k).value = cfg[k];
  $('dedupe').checked = cfg.dedupe;
  $('stopOnBlocked').checked = cfg.stopOnBlocked;
  $('mapsUrl').value = cfg.mapsUrl;
}

/* ------------------------------------------------------------------ *
 * run control
 * ------------------------------------------------------------------ */
async function start() {
  const v = validate();
  if (!v.ok) return;

  /* A previous run's results would be wiped - make that an explicit choice. */
  if (lastState && (lastState.status === 'stopped' || lastState.status === 'error' || lastState.status === 'done')) {
    const kept = (lastState.areas || []).reduce((a, x) => a + (x.found || 0), 0);
    const msg = kept
      ? `Starting a new job discards the ${kept.toLocaleString()} results already collected.\n\nDownload them first, or press Cancel to keep the current run.`
      : 'Start a new job? The current run will be discarded.';
    if (!confirm(msg)) return;
  }

  readCfg();
  hideError();
  $('startBtn').disabled = true;
  setStartLabel('Starting…');

  const payload = {
    areas: v.areas,
    profession: v.profession,
    mapsUrl: cfg.mapsUrl,
    config: {
      delayBetweenAreas: cfg.delayBetweenAreas,
      maxScrollSeconds: cfg.maxScrollSeconds,
      stableRounds: cfg.stableRounds,
      startDelaySeconds: cfg.startDelaySeconds,
      dedupe: cfg.dedupe,
      stopOnBlocked: cfg.stopOnBlocked
    }
  };

  let res = await send({ type: 'START_JOB', payload });
  if (res && res.needsPermission) {
    const granted = await chrome.permissions.request({ origins: [res.needsPermission] });
    if (!granted) {
      showError(`Access to ${res.needsPermission} was denied. Pick a different Maps domain in Advanced settings.`);
      $('startBtn').disabled = false;
      return;
    }
    res = await send({ type: 'START_JOB', payload });
  }
  if (res && res.error) showError(res.error);
  else { $('areas').value = ''; validate(); }
  $('startBtn').disabled = false;
}

async function act(type, extra) {
  hideError();
  const res = await send(Object.assign({ type }, extra || {}));
  if (res && res.error) showError(res.error);
}

const send = (m) => chrome.runtime.sendMessage(m).catch(() => ({ error: 'The extension worker did not respond. Try again.' }));

function showError(msg) { const e = $('error'); e.textContent = msg; e.hidden = false; }
function hideError() { $('error').hidden = true; }

/* ------------------------------------------------------------------ *
 * render
 * ------------------------------------------------------------------ */
function render(state) {
  lastState = state;
  const st = state ? state.status : 'idle';
  const pill = $('statusPill');
  pill.textContent = STATUS_TEXT[st] || st;
  pill.className = 'pill ' + (STATUS_CLASS[st] || 'idle');

  const running = st === 'running';
  const live = !!state && st !== 'idle';
  const resumable = st === 'paused' || st === 'stopped' || st === 'error';
  const over = st === 'done' || st === 'stopped' || st === 'error';

  $('progressCard').hidden = !live;
  $('exportCard').hidden = !over;

  $('setupCard').style.opacity = running ? '.5' : '1';
  $('areas').disabled = running;
  $('profession').disabled = running;

  $('startBtn').hidden = running || st === 'paused';
  $('pauseBtn').hidden = !running;
  $('resumeBtn').hidden = !resumable;
  $('skipBtn').hidden = !resumable;
  $('stopBtn').hidden = !running;

  if (!state) { $('areaList').innerHTML = ''; validate(); return; }

  const areas = state.areas || [];
  const done = areas.filter((a) => a.status === 'done' || a.status === 'empty' || a.status === 'skipped').length;
  const found = areas.reduce((a, x) => a + (x.found || 0), 0);
  const total = areas.length;

  $('pDone').textContent = done;
  $('pTotal').textContent = total;
  $('pFound').textContent = found.toLocaleString();
  $('pFill').style.width = (total ? (done / total) * 100 : 0) + '%';
  $('curArea').textContent =
    st === 'done' ? `All ${total} areas finished`
    : st === 'paused' ? 'Paused'
    : st === 'stopped' ? 'Stopped'
    : state.currentArea || '—';

  const elapsed = ((state.finishedAt || Date.now()) - (state.startedAt || Date.now())) / 1000;
  $('pElapsed').textContent = fmtDur(elapsed) + ' elapsed';
  if (done > 0 && done < total) {
    const per = elapsed / done;
    $('pEta').textContent = '~' + fmtDur(per * (total - done)) + ' remaining';
  } else {
    $('pEta').textContent = done + ' / ' + total + ' areas';
  }

  renderAreaList(areas, state);
  validate();
}

function renderAreaList(areas, state) {
  const host = $('areaList');
  const cur = state.currentIndex;
  const from = Math.max(0, cur - 3);
  const to = Math.min(areas.length, from + 220);
  const frag = document.createDocumentFragment();

  for (let i = from; i < to; i++) {
    const a = areas[i];
    const row = document.createElement('div');
    row.className = 'area-row ' + (DOT_CLASS[a.status] || '');
    row.innerHTML =
      '<span class="dot"></span>' +
      '<span class="nm" title="' + esc(a.name) + (a.error ? ' — ' + esc(a.error) : '') + '">' + esc(a.name) + '</span>' +
      '<span class="ct">' + (a.found != null ? a.found + (a.status === 'error' ? ' ✕' : a.status === 'empty' ? ' ∅' : '') : '·') + '</span>';
    frag.appendChild(row);
  }
  if (from > 0) {
    const more = document.createElement('div');
    more.className = 'area-row';
    more.innerHTML = '<span class="dot"></span><span class="nm">… ' + from + ' earlier areas</span><span class="ct"></span>';
    frag.insertBefore(more, frag.firstChild);
  }
  if (to < areas.length) {
    const more = document.createElement('div');
    more.className = 'area-row';
    more.innerHTML = '<span class="dot"></span><span class="nm">… ' + (areas.length - to) + ' more queued</span><span class="ct"></span>';
    frag.appendChild(more);
  }
  host.innerHTML = '';
  host.appendChild(frag);
}

function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm ' + String(sec).padStart(2, '0') + 's';
  return sec + 's';
}

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */
async function gather() {
  if (exportCache) return exportCache;
  $('busyText').textContent = 'Collecting results…';
  $('busy').hidden = false;
  try {
    const res = await send({ type: 'EXPORT_ROWS' });
    if (res && res.error) { showError(res.error); return null; }
    const { areaData } = await chrome.storage.local.get(S_DATA);
    res.areaSummary = areaSummary(lastState ? lastState.areas : [], areaData || {});
    exportCache = res;
    const m = res.meta;
    $('exportMeta').textContent =
      `${m.doneCount}/${m.areaCount} areas · ${res.rows.length.toLocaleString()} unique rows · ${res.duplicates.toLocaleString()} duplicates removed · ${m.emptyCount} empty · ${m.failedCount} failed`;
    return res;
  } finally {
    $('busy').hidden = true;
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

function safeName(s) {
  return String(s || 'maps').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'maps';
}

async function exportXlsx() {
  const res = await gather();
  if (!res) return;
  $('busyText').textContent = 'Building workbook…';
  $('busy').hidden = false;
  await new Promise((r) => setTimeout(r, 30));

  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();

  /* --- sheet 1: businesses --- */
  const head = EXPORT_COLUMNS.map((c) => c.header);
  const aoa = [head].concat(res.rows.map((r) => EXPORT_COLUMNS.map((c) => {
    const v = r[c.key];
    if (c.key === 'rating' || c.key === 'latitude' || c.key === 'longitude') {
      const n = parseFloat(v);
      return isFinite(n) && v !== '' ? n : '';
    }
    if (c.key === 'reviews' || c.key === 'areaCount' || c.key === 'row') {
      const n = parseInt(v, 10);
      return isFinite(n) ? n : '';
    }
    return v === undefined || v === null ? '' : v;
  })));
  const ws1 = XLSX.utils.aoa_to_sheet(aoa);
  ws1['!cols'] = EXPORT_COLUMNS.map((c) => ({ wch: c.width }));
  ws1['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, aoa.length - 1), c: EXPORT_COLUMNS.length - 1 } }) };
  ws1['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws1, 'Businesses');

  /* --- sheet 2: per-area summary --- */
  const aHead = ['Area', 'Status', 'Results', 'Unique', 'With Phone', 'With Website', 'With Rating', 'Seconds', 'Note'];
  const ws2 = XLSX.utils.aoa_to_sheet([aHead].concat(
    (res.areaSummary || []).map((r) => [r.area, r.status, r.results, r.unique, r.withPhone, r.withWebsite, r.withRating, r.seconds, r.note])
  ));
  ws2['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 9 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Areas');

  /* --- sheet 3: run summary --- */
  const m = res.meta;
  const ws3 = XLSX.utils.aoa_to_sheet([
    ['Metric', 'Value'],
    ['Profession', m.profession],
    ['Areas queued', m.areaCount],
    ['Areas completed', m.doneCount],
    ['Areas with no results', m.emptyCount],
    ['Areas failed', m.failedCount],
    ['Unique businesses', res.rows.length],
    ['Duplicate records removed', res.duplicates],
    ['Started', m.startedAt ? new Date(m.startedAt).toLocaleString() : ''],
    ['Finished', m.finishedAt ? new Date(m.finishedAt).toLocaleString() : ''],
    ['Duration', fmtDur(((m.finishedAt || Date.now()) - m.startedAt) / 1000)]
  ]);
  ws3['!cols'] = [{ wch: 28 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'Summary');

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    safeName(m.profession) + '-google-maps-' + stamp() + '.xlsx');

  $('busy').hidden = true;
  setTimeout(() => (exportCache = null), 500);
}

async function exportCsv() {
  const res = await gather();
  if (!res) return;
  const q = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [EXPORT_COLUMNS.map((c) => q(c.header)).join(',')];
  for (const r of res.rows) lines.push(EXPORT_COLUMNS.map((c) => q(r[c.key])).join(','));
  download(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }),
    safeName(res.meta.profession) + '-google-maps-' + stamp() + '.csv');
}

/* ------------------------------------------------------------------ *
 * preview
 * ------------------------------------------------------------------ */
async function showPreview() {
  const res = await gather();
  if (!res) return;
  const cols = EXPORT_COLUMNS.slice(0, 9);
  const m = res.meta;
  $('previewTitle').textContent = `${res.rows.length.toLocaleString()} unique rows · ${res.duplicates.toLocaleString()} duplicates removed · ${m.doneCount}/${m.areaCount} areas`;

  let html = '<table><thead><tr><th>#</th>' +
    cols.map((c) => `<th>${esc(c.header)}</th>`).join('') +
    '<th>Areas</th></tr></thead><tbody>';
  for (const r of res.rows.slice(0, 500)) {
    html += '<tr><td class="num">' + r.row + '</td>' +
      cols.map((c) => `<td title="${esc(r[c.key])}">${esc(r[c.key])}</td>`).join('') +
      `<td>${esc(r.areas)}</td></tr>`;
  }
  html += '</tbody></table>';
  if (res.rows.length > 500) html += `<div style="padding:8px;font-size:11px;color:#99a1ad">Showing first 500 of ${res.rows.length.toLocaleString()} rows.</div>`;
  $('previewBody').innerHTML = html;
  $('previewModal').hidden = false;
}

/* ------------------------------------------------------------------ *
 * wiring
 * ------------------------------------------------------------------ */
function wire() {
  $('areas').addEventListener('input', validate);
  $('profession').addEventListener('input', validate);
  $('areas').addEventListener('paste', () => setTimeout(validate, 0));

  document.querySelectorAll('[data-sample]').forEach((b) => {
    b.addEventListener('click', () => {
      $('areas').value = b.dataset.sample.split('|').join('\n');
      validate();
    });
  });
  $('clearAreas').addEventListener('click', () => { $('areas').value = ''; validate(); $('areas').focus(); });

  $('startBtn').addEventListener('click', start);
  $('pauseBtn').addEventListener('click', () => act('PAUSE_JOB'));
  $('stopBtn').addEventListener('click', () => act('STOP_JOB'));
  $('resumeBtn').addEventListener('click', () => act('RESUME_JOB'));
  $('skipBtn').addEventListener('click', () => act('SKIP_AREA', { index: lastState ? lastState.currentIndex : 0 }));

  /* Persist advanced settings as they change, otherwise readCfg() only ever
     runs on Start and every tweak is lost when the popup closes. */
  for (const k of ['delayBetweenAreas', 'maxScrollSeconds', 'stableRounds', 'startDelaySeconds', 'mapsUrl']) {
    $(k).addEventListener('change', () => { readCfg(); writeCfg(); });
  }
  for (const k of ['dedupe', 'stopOnBlocked']) {
    $(k).addEventListener('change', () => { readCfg(); writeCfg(); });
  }

  $('xlsxBtn').addEventListener('click', exportXlsx);
  $('csvBtn').addEventListener('click', exportCsv);
  $('previewBtn').addEventListener('click', showPreview);
  $('closePreview').addEventListener('click', () => ($('previewModal').hidden = true));
  $('previewModal').addEventListener('click', (e) => { if (e.target === $('previewModal')) $('previewModal').hidden = true; });
  $('newJobBtn').addEventListener('click', async () => { exportCache = null; await act('CLEAR_JOB'); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('previewModal').hidden = true; return; }
    /* Enter belongs to the textarea - it must insert a newline, not start a run. */
    if (e.key !== 'Enter') return;
    const tag = e.target && e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.target && e.target.type === 'text') return;
    if ($('startBtn').disabled || $('startBtn').hidden) return;
    e.preventDefault();
    start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.state) render(changes.state.newValue);
    if (changes[S_CFG] && changes[S_CFG].newValue) { cfg = { ...DEFAULT_CFG, ...changes[S_CFG].newValue }; }
  });
}

async function init() {
  const store = await chrome.storage.local.get([S_CFG, S_STATE, S_JOB]);
  cfg = { ...DEFAULT_CFG, ...(store[S_CFG] || {}) };
  fillDefaults();
  wire();
  render(store[S_STATE] || null);
  if (store[S_JOB]) $('profession').placeholder = store[S_JOB].profession;
  validate();

  if (!ticking) {
    ticking = true;
    setInterval(() => { if (lastState) render(lastState); }, 1000);
  }
}

init();
