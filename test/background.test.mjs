/* Unit tests for the service worker.
 *
 * background.js is a side-effecting module, so we install a fake `chrome`
 * global, import it for its registered message listener, and drive it exactly
 * the way the popup and the content script do.
 *
 * Run: node test/background.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'background.js'), 'utf8');

let pass = 0, fail = 0;
const eq = (n, a, b) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n         expected ' + B + '\n         actual   ' + A); }
};
const ok = (n, cond) => eq(n, !!cond, true);

/* ------------------------------------------------------------------ *
 * fake chrome
 * ------------------------------------------------------------------ */
function installChrome() {
  const db = {};
  const log = { created: [], updated: [], notifications: [], scripts: [], alarms: [] };
  let nextTabId = 100;
  const listeners = { message: null };

  const store = {
    async get(keys) {
      if (keys == null) return { ...db };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in db) out[k] = JSON.parse(JSON.stringify(db[k]));
      return out;
    },
    async set(obj) { for (const k of Object.keys(obj)) db[k] = JSON.parse(JSON.stringify(obj[k])); },
    async remove(keys) { for (const k of [].concat(keys)) delete db[k]; }
  };

  globalThis.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (f) => (listeners.message = f) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getManifest: () => ({ version: '1.0.0' })
    },
    storage: { local: store },
    permissions: { contains: async () => true, request: async () => true },
    alarms: {
      create: (n) => log.alarms.push(n),
      clear: async () => true,
      onAlarm: { addListener: () => {} }
    },
    notifications: {
      create: (id, o) => { log.notifications.push(o); return Promise.resolve(id); },
      clear: async () => true
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async (s) => log.scripts.push(...(Array.isArray(s) ? s : [s])),
      unregisterContentScripts: async () => true
    },
    tabs: {
      create: async (opts) => {
        const id = nextTabId++;
        log.created.push({ id, url: opts.url, active: !!opts.active });
        return { id, url: opts.url, active: !!opts.active };
      },
      update: async (id, opts) => {
        /* the tab id must already be visible in storage when this happens,
           because the content script fires CLAIM at document_start */
        const { state } = await store.get('state');
        log.updated.push({ id, url: opts.url, stateTabId: state ? state.tabId : null, status: state ? state.status : null });
        return { id };
      },
      query: async () => [],
      get: async (id) => ({ id }),
      sendMessage: async () => ({ ok: true }),
      onRemoved: { addListener: () => {} }
    },
    action: { setBadgeText: async () => {} }
  };

  return { db, log, listeners, store };
}

function fromUrl(rel) {
  return pathToFileURL(join(here, '..', rel.replace(/^\.\//, ''))).href;
}

/** Import background.js fresh (it has module-level side effects) and return a
 *  driver bound to the fake chrome. The static `import` of merge.js is
 *  rewritten to a file URL so the data: module can resolve it. */
let bootSeq = 0;
async function boot() {
  const env = installChrome();
  /* the unique marker defeats Node's data: module cache so every boot()
     re-runs the module's top-level side effects against a fresh fake */
  const body = SRC.replace(
    /^import\s+\{([^}]+)\}\s+from\s+'([^']+)';?$/m,
    (m, names, from) => `const { ${names} } = await import(${JSON.stringify(fromUrl(from))});`
  ) + `\n// boot ${++bootSeq}\n`;
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(body).toString('base64');
  await import(dataUrl);
  ok('background.js registered a message listener', !!env.listeners.message);
  return env;
}

/** Send a message the way chrome.runtime.sendMessage does. */
function send(env, msg, sender) {
  return new Promise((resolve) => {
    let done = false;
    const sendResponse = (r) => { if (!done) { done = true; resolve(r); } };
    const keepOpen = env.listeners.message(msg, sender || {}, sendResponse);
    /* a listener that returns true without ever calling sendResponse would
       hang the caller; fail loudly instead of timing out silently */
    setTimeout(() => { if (!done) { done = true; resolve({ __hung: true, keepOpen }); } }, 4000);
  });
}

const base = (over = {}) => Object.assign({ profession: 'Cafe', areas: ['Denver', 'Boulder'], mapsUrl: 'https://www.google.com/maps/search/x', config: {} }, over);

/* ================================================================== *
 * validation
 * ================================================================== */
console.log('\n--- validation ---');
{
  const env = await boot();
  eq('rejects a blank profession', (await send(env, { type: 'START_JOB', payload: base({ profession: '   ' }) })).error, 'Profession is required.');
  eq('rejects an empty area list', (await send(env, { type: 'START_JOB', payload: base({ areas: [] }) })).error, 'At least one area name is required.');
  eq('rejects more than 1000 areas', (await send(env, { type: 'START_JOB', payload: base({ areas: Array.from({ length: 1001 }, (_, i) => 'A' + i) }) })).error, 'Maximum 1000 areas per run.');
  eq('accepts exactly 1000 areas', (await send(env, { type: 'START_JOB', payload: base({ areas: Array.from({ length: 1000 }, (_, i) => 'A' + i) }) })).ok, true);
  eq('unknown message is reported', (await send(env, { type: 'NOPE' })).error, 'Unknown message');
  eq('a missing payload does not hang the channel', (await send(env, { type: 'START_JOB' })).error, 'Profession is required.');
}

/* ================================================================== *
 * the startup race
 * ================================================================== */
console.log('\n--- startup: the tab owns its id before Maps loads ---');
{
  const env = await boot();
  const res = await send(env, { type: 'START_JOB', payload: base() });

  eq('start succeeds', res.ok, true);
  eq('the tab is created blank first', env.log.created[0].url, 'about:blank');
  eq('the blank tab is focused', env.log.created[0].active, true);
  eq('exactly one tab is created', env.log.created.length, 1);
  ok('the Maps url is applied afterwards', /\/maps\/search\//.test(env.log.updated[0].url));
  ok('the search carries the profession', /Cafe%20in%20Denver/.test(env.log.updated[0].url));
  ok('hl=en is forced', /[?&]hl=en/.test(env.log.updated[0].url));

  /* the ordering that the content script's CLAIM depends on */
  eq('the tab id is already in storage when Maps loads', env.log.updated[0].stateTabId, env.log.created[0].id);
  eq('the job is running by then', env.log.updated[0].status, 'running');
  eq('the returned tab id is the real one', res.tabId, env.log.created[0].id);
  eq('storage tabId matches the created tab', env.db.state.tabId, env.log.created[0].id);
  eq('total is reported', res.total, 2);

  /* a content script that asks right now must be let in */
  const claim = await send(env, { type: 'CLAIM' }, { tab: { id: env.log.created[0].id } });
  eq('the owning tab is granted the claim', claim.go, true);
  const other = await send(env, { type: 'CLAIM' }, { tab: { id: 999 } });
  eq('a different tab is refused', other.go, false);
  eq('a sender with no tab is refused', (await send(env, { type: 'CLAIM' }, {})).go, false);
}

/* ================================================================== *
 * area list handling
 * ================================================================== */
console.log('\n--- areas: dedupe, trim, drop blanks ---');
{
  const env = await boot();
  await send(env, { type: 'START_JOB', payload: base({ areas: ['  Denver ', 'Denver', 'denver', '', '   ', 'Boulder'] }) });
  eq('blank entries dropped and duplicates collapsed', env.db.job.areas, ['Denver', 'Boulder']);
  eq('state rows match the cleaned list', env.db.state.areas.map((a) => a.name), ['Denver', 'Boulder']);
  eq('areas start pending', env.db.state.areas.map((a) => a.status), ['pending', 'pending']);
  eq('profession is trimmed', env.db.job.profession, 'Cafe');
  eq('a fresh run clears previous results', env.db.areaData, {});
  eq('mapsBase is normalised', env.db.job.mapsBase, 'https://www.google.com/maps');
}

/* ================================================================== *
 * pause / stop / resume never lose the queue
 * ================================================================== */
console.log('\n--- pause / stop / resume ---');
{
  const env = await boot();
  await send(env, { type: 'START_JOB', payload: base({ areas: ['A', 'B', 'C'] }) });

  /* pretend area 0 is in flight */
  env.db.state.areas[0] = { name: 'A', status: 'running', found: 2, error: '' };
  env.db.state.currentArea = 'A';
  await env.store.set({ state: env.db.state });

  const p = await send(env, { type: 'PAUSE_JOB' });
  eq('pause succeeds', p.ok, true);
  eq('status becomes paused', env.db.state.status, 'paused');
  eq('pause does not cancel the pending queue', env.db.state.areas.map((a) => a.status), ['running', 'pending', 'pending']);

  const r = await send(env, { type: 'RESUME_JOB' });
  eq('resume succeeds', r.ok, true);
  eq('status back to running', env.db.state.status, 'running');
  eq('the in-flight area is re-queued, not lost', env.db.state.areas.map((a) => a.status), ['pending', 'pending', 'pending']);
  eq('its collected count is preserved', env.db.state.areas[0].found, 2);
  ok('resume bounces the tab', env.log.updated.length > 1);

  /* stop must not nuke the queue either */
  env.db.state.areas[1] = { name: 'B', status: 'running', found: 0, error: '' };
  await env.store.set({ state: env.db.state });
  const s = await send(env, { type: 'STOP_JOB' });
  eq('stop succeeds', s.ok, true);
  eq('status becomes stopped', env.db.state.status, 'stopped');
  eq('stop leaves every area resumable', env.db.state.areas.map((a) => a.status), ['pending', 'running', 'pending']);
  eq('nothing is marked cancelled', JSON.stringify(env.db.state).includes('cancelled'), false);

  /* and a stopped job can still be resumed */
  await send(env, { type: 'RESUME_JOB' });
  eq('a stopped job resumes', env.db.state.status, 'running');

  /* a finished job is terminal */
  env.db.state.status = 'done';
  await env.store.set({ state: env.db.state });
  eq('resuming a finished job is refused', (await send(env, { type: 'RESUME_JOB' })).error, 'Nothing to resume.');
  eq('pausing a finished job is a no-op', (await send(env, { type: 'PAUSE_JOB' })).ok, true);
  eq('a finished job stays done', env.db.state.status, 'done');
}

/* ================================================================== *
 * skip / clear
 * ================================================================== */
console.log('\n--- skip and clear ---');
{
  const env = await boot();
  await send(env, { type: 'START_JOB', payload: base({ areas: ['A', 'B'] }) });
  const bad = await send(env, { type: 'SKIP_AREA', index: 99 });
  eq('skipping an invalid index is refused', bad.error, 'Invalid area.');
  await send(env, { type: 'SKIP_AREA', index: 0 });
  eq('the area is marked skipped', env.db.state.areas[0].status, 'skipped');

  await send(env, { type: 'CLEAR_JOB' });
  eq('clear removes the state', env.db.state, undefined);
  eq('clear removes the job', env.db.job, undefined);
  eq('clear removes results', env.db.areaData, undefined);
}

/* ================================================================== *
 * export rows
 * ================================================================== */
console.log('\n--- EXPORT_ROWS ---');
{
  const env = await boot();
  eq('export without a job is refused', (await send(env, { type: 'EXPORT_ROWS' })).error, 'No job data found.');

  await send(env, { type: 'START_JOB', payload: base({ areas: ['North', 'South'] }) });
  env.db.state.areas = [
    { name: 'North', status: 'done', found: 2, error: '' },
    { name: 'South', status: 'empty', found: 0, error: '' }
  ];
  env.db.areaData = {
    0: [
      { name: 'Alpha', area: 'North', placeId: '0xaaa:0xbbb', category: 'Cafe', rating: 4.5, reviews: 10, address: '1 A St', phone: '', website: '', lat: '', lng: '', openStatus: '', priceLevel: '', email: '', mapsLink: '' },
      { name: 'Beta', area: 'North', placeId: '0xccc:0xddd', category: '', rating: '', reviews: '', address: '2 B St', phone: '555', website: '', lat: '', lng: '', openStatus: '', priceLevel: '', email: '', mapsLink: '' }
    ],
    1: [
      { name: 'Alpha', area: 'South', placeId: '0xaaa:0xbbb', category: '', rating: 4.9, reviews: 99, address: '1 A St', phone: '555-1', website: 'https://a.example', lat: '', lng: '', openStatus: '', priceLevel: '', email: '', mapsLink: '' }
    ]
  };
  await env.store.set({ state: env.db.state, areaData: env.db.areaData });

  const ex = await send(env, { type: 'EXPORT_ROWS' });
  eq('two unique rows', ex.rows.length, 2);
  eq('the duplicate is reported', ex.duplicates, 1);
  eq('the shared place spans both areas', ex.rows.find((r) => r.name === 'Alpha').areas, 'North | South');
  eq('meta counts the profession', ex.meta.profession, 'Cafe');
  eq('meta counts processed areas (done + empty)', ex.meta.doneCount, 2);
  eq('meta counts empty areas', ex.meta.emptyCount, 1);
  eq('meta counts no failures', ex.meta.failedCount, 0);
  eq('meta counts areas', ex.meta.areaCount, 2);
  eq('rows are numbered from 1', ex.rows[0].row, 1);
  ok('columns are advertised', Array.isArray(ex.columns) && ex.columns.length > 10);
  eq('no internal payload leaks into rows', Object.prototype.hasOwnProperty.call(ex.rows[0], '_raw'), false);

  /* dedupe:false must keep both Alpha rows */
  env.db.state.config = { dedupe: false };
  await env.store.set({ state: env.db.state });
  const raw = await send(env, { type: 'EXPORT_ROWS' });
  eq('dedupe:false keeps every raw hit', raw.rows.length, 3);
  eq('no duplicates reported when dedupe is off', raw.duplicates, 0);
}

/* ================================================================== *
 * resilience
 * ================================================================== */
console.log('\n--- resilience ---');
{
  const env = await boot();
  /* storage.get throwing must still resolve the message, never hang it */
  const orig = env.store.get;
  env.store.get = async () => { throw new Error('storage exploded'); };
  const res = await send(env, { type: 'CLAIM' });
  ok('a throwing handler answers with an error', res && typeof res.error === 'string' && /storage exploded/.test(res.error));
  ok('the error channel never hangs', !res.__hung);
  env.store.get = orig;

  /* permission refusal must be surfaced as needsPermission, not a broken run */
  chrome.permissions.contains = async () => false;
  const need = await send(env, { type: 'START_JOB', payload: base() });
  eq('a missing host permission is requested', need.needsPermission, 'https://www.google.com/maps/*');
  eq('no tab is opened without permission', env.log.created.length, 0);
  chrome.permissions.contains = async () => true;

  /* other google TLDs map to their own base */
  const de = await send(env, { type: 'START_JOB', payload: base({ mapsUrl: 'https://www.google.de/maps/search/x' }) });
  eq('a .de run is created on the de host', de.ok, true);
  eq('a .de run stores the de base', env.db.job.mapsBase, 'https://www.google.de/maps');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
