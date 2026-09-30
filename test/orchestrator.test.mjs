/* End-to-end test of the orchestrator.
 *
 * Drives the real content.js across several areas against an in-memory
 * chrome.storage and a synthetic Maps page, mimicking a browser by
 * re-injecting the script on each page load (which is exactly how the real
 * extension resumes after location.replace).
 *
 * Run: JSDOM_PATH=... node test/orchestrator.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

async function loadJsdom() {
  const cands = [process.env.JSDOM_PATH, join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'jsdom', 'lib', 'api.js')].filter(Boolean);
  for (const c of cands) { if (existsSync(c)) return await import(pathToFileURL(c).href); }
  try { return await import('jsdom'); } catch (_) {}
  throw new Error('jsdom not found');
}
const { JSDOM, VirtualConsole } = await loadJsdom();

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'content.js'), 'utf8');
const MERGE = await import(pathToFileURL(join(here, '..', 'lib', 'merge.js')).href);

let pass = 0, fail = 0;
const eq = (n, a, b) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n         expected ' + B + '\n         actual   ' + A); }
};
const ok = (n, cond) => eq(n, !!cond, true);

/* ------------------------------------------------------------------ *
 * in-memory chrome.storage.local (with real change notifications)
 * ------------------------------------------------------------------ */
function makeStore() {
  const db = {};
  const listeners = new Set();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const notify = (changes) => {
    for (const l of [...listeners]) { try { l(changes, 'local'); } catch (_) {} }
  };
  const store = {
    db,
    local: {
      async get(keys) {
        if (keys == null) return { ...db };
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in db) out[k] = clone(db[k]);
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const k of Object.keys(obj)) {
          const oldValue = clone(db[k]);
          db[k] = clone(obj[k]);
          changes[k] = { oldValue, newValue: clone(db[k]) };
        }
        notify(changes);
      },
      async remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) {
          if (!(k in db)) continue;
          changes[k] = { oldValue: clone(db[k]), newValue: undefined };
          delete db[k];
        }
        notify(changes);
      }
    },
    onChanged: {
      addListener: (f) => listeners.add(f),
      removeListener: (f) => listeners.delete(f)
    },
    listenerCount: () => listeners.size
  };
  return store;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Google Maps rewrites the search path: %20 becomes "+" and a slash is added. */
function mapsRewrites(url) {
  return url.replace(/%20/g, '+');
}

/* A Maps results page for a query, with `n` cards.
   placeIds are 0x<hex>:0x<hex> as Google actually emits them. `seed` keeps
   ids from colliding across areas, so cross-area dedupe is exercised by
   scenario 2 instead of by accident. */
function mapsPage(query, n, seed = 0) {
  const cards = Array.from({ length: n }, (_, i) => `
    <div role="article" aria-label="Shop ${query} #${i}, Store">
      <a href="/maps/place/Shop+${query}+${i}/data=!3m1!4b1!3d39.7!4d-104.9!1s0xdeadbee${seed}${i}:0xcafebab${seed}${i}">
        <div role="heading" aria-level="3">Shop ${query} #${i}</div>
      </a>
      <div class="W4Efsd">${100 + i} Main St, Denver, CO</div>
      <span aria-label="4.${i} stars">4.${i}</span>
      <span aria-label="${10 + i} reviews">${10 + i}</span>
    </div>`).join('');
  return `<!doctype html><html><body><div role="feed">${cards}</div></body></html>`;
}

const quietConsole = new VirtualConsole();
quietConsole.on('jsdomError', () => { /* location.replace navigation: expected */ });

/** Boot one "page load" of the extension on `url`, wired to `store`. */
function loadPage(store, url, html) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', virtualConsole: quietConsole });
  const w = dom.window;
  let claimAnswer = { go: true };
  w.chrome = {
    storage: { local: store.local, onChanged: store.onChanged },
    runtime: { sendMessage: async (m) => (m && m.type === 'CLAIM' ? claimAnswer : undefined) }
  };
  w.__setClaim = (v) => { claimAnswer = v; };
  w.eval(SRC);
  return w;
}

async function waitFor(pred, label, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return true;
    await sleep(60);
  }
  console.log('  (timeout waiting for ' + label + ')');
  return false;
}

/* ================================================================== *
 * SCENARIO 1 - three areas run to completion
 * ================================================================== */
console.log('\n--- scenario 1: three areas, full run ---');
{
  const store = makeStore();
  const areas = ['Aurora', 'Boulder', 'Centennial'];
  store.db.job = { profession: 'Coffee shop', areas, mapsBase: 'https://www.google.com/maps', createdAt: 1 };
  store.db.state = {
    status: 'running', tabId: 7, currentIndex: 0, currentArea: '', expectedUrl: '',
    areas: areas.map((n) => ({ name: n, status: 'pending', found: 0, error: '' })),
    config: { delayBetweenAreas: 0, maxScrollSeconds: 12, stableRounds: 2, startDelaySeconds: 0, dedupe: true, stopOnBlocked: false },
    warmedUp: false, navForIndex: -1, heartbeatAt: Date.now(), startedAt: Date.now(), finishedAt: 0, error: ''
  };

  const counts = { Aurora: 3, Boulder: 2, Centennial: 0 };

  for (let hop = 0; hop < 12; hop++) {
    const st = store.db.state;
    if (!st || st.status === 'done') break;
    const i = st.currentIndex;
    if (i >= areas.length) break;

    /* navigate: build the URL, then load the page exactly as Maps would serve it */
    const want = `https://www.google.com/maps/search/${encodeURIComponent(`Coffee shop in ${areas[i]}`)}?hl=en`;
    const servedUrl = mapsRewrites(want);
    const html = counts[areas[i]]
      ? mapsPage(areas[i], counts[areas[i]], i)
      : '<!doctype html><html><body><div>Your search did not match any places.</div></body></html>';

    loadPage(store, servedUrl, html);

    const before = st.currentIndex;
    await waitFor(async () => {
      const s = store.db.state;
      return s.currentIndex !== before || s.status === 'done' || s.status === 'paused';
    }, 'area ' + areas[i] + ' to advance');
  }

  const st = store.db.state;
  eq('job reached done', st.status, 'done');
  eq('currentIndex consumed all areas', st.currentIndex, 3);
  eq('every area marked done', st.areas.map((a) => a.status), ['done', 'done', 'empty']);
  eq('per-area found counts', st.areas.map((a) => a.found), [3, 2, 0]);
  eq('finishedAt stamped', typeof st.finishedAt === 'number' && st.finishedAt > 0, true);
  eq('navForIndex reset', st.navForIndex, -1);

  const ad = store.db.areaData;
  eq('areaData has one entry per visited area', Object.keys(ad).length, 3);
  eq('areaData[0] row count', ad['0'].length, 3);
  eq('areaData[1] row count', ad['1'].length, 2);
  eq('no-result area stores an empty list', ad['2'].length, 0);
  eq('rows carry the area label', ad['0'][0].area, 'Aurora');
  eq('parsed name', ad['0'][0].name, 'Shop Aurora #0');
  eq('parsed rating', ad['0'][0].rating, 4);
  eq('parsed reviews', ad['0'][0].reviews, 10);
  eq('placeId comes from the hex !1s segment', ad['0'][0].placeId, '0xdeadbee00:0xcafebab00');
  eq('no duplicate rows inside one area', new Set(ad['0'].map((r) => r.placeId)).size, 3);

  /* cross-area dedupe through the export engine */
  const merged = MERGE.mergeAreaData(st.areas, ad, true);
  eq('merged unique rows', merged.rows.length, 5);
  eq('no cross-area collisions in this fixture', merged.duplicates, 0);
  eq('areas summary is aligned with state.areas', MERGE.areaSummary(st.areas, ad).map((r) => r.area), areas);
}

/* ================================================================== *
 * SCENARIO 2 - the same business listed in two areas collapses to one row
 * ================================================================== */
console.log('\n--- scenario 2: same place in two areas dedupes ---');
{
  const store = makeStore();
  const areas = ['North', 'South'];
  store.db.job = { profession: 'Dentist', areas, mapsBase: 'https://www.google.com/maps', createdAt: 1 };
  store.db.state = {
    status: 'running', tabId: 3, currentIndex: 0, currentArea: '', expectedUrl: '',
    areas: areas.map((n) => ({ name: n, status: 'pending', found: 0, error: '' })),
    config: { delayBetweenAreas: 0, maxScrollSeconds: 12, stableRounds: 2, startDelaySeconds: 0, dedupe: true, stopOnBlocked: false },
    warmedUp: false, navForIndex: -1, heartbeatAt: Date.now(), startedAt: Date.now(), finishedAt: 0, error: ''
  };

  /* one shared place id, so the two areas genuinely overlap */
  const page = (label, uniq) => `<!doctype html><html><body><div role="feed">
    <div role="article" aria-label="Shared Clinic, Clinic">
      <a href="/maps/place/Shared+Clinic/data=!3m1!4b1!3d39.7!4d-104.9!1s0x1a2b3c4d:0x5e6f7081"><div role="heading" aria-level="3">Shared Clinic</div></a>
      <div class="W4Efsd">1 Main St, Denver, CO</div><span aria-label="4.0 stars">4.0</span>
    </div>
    <div role="article" aria-label="Only ${label}, Clinic">
      <a href="/maps/place/Only+${label}/data=!3m1!4b1!3d39.8!4d-104.8!1s${uniq}"><div role="heading" aria-level="3">Only ${label}</div></a>
      <div class="W4Efsd">2 Main St, Denver, CO</div>
    </div>
  </div></body></html>`;

  for (let hop = 0; hop < 8; hop++) {
    const st = store.db.state;
    if (!st || st.status === 'done' || st.currentIndex >= areas.length) break;
    const i = st.currentIndex;
    const want = `https://www.google.com/maps/search/${encodeURIComponent(`Dentist in ${areas[i]}`)}?hl=en`;
    loadPage(store, mapsRewrites(want), page(areas[i], i === 0 ? '0x0a0b0c0d:0x0e0f1011' : '0x1a2b3c4f:0x5e6f7083'));
    const before = st.currentIndex;
    await waitFor(async () => {
      const s = store.db.state;
      return s.currentIndex !== before || s.status === 'done';
    }, 'advance past ' + areas[i]);
  }

  eq('job done', store.db.state.status, 'done');
  const ad = store.db.areaData;
  eq('4 raw hits collected', ad['0'].length + ad['1'].length, 4);
  const m = MERGE.mergeAreaData(store.db.state.areas, ad, true);
  eq('3 unique rows after dedupe', m.rows.length, 3);
  eq('1 duplicate removed', m.duplicates, 1);
  const shared = m.rows.find((r) => r.name === 'Shared Clinic');
  eq('shared place lists both areas', shared.areas, 'North | South');
  eq('shared place area count', shared.areaCount, 2);
  eq('distinct places do not collapse', MERGE.mergeAreaData(store.db.state.areas, ad, true).rows.filter((r) => /^Only /.test(r.name)).length, 2);
}

/* ================================================================== *
 * SCENARIO 3 - a second tab must not hijack the run (CLAIM gate)
 * ================================================================== */
console.log('\n--- scenario 3: duplicate tab is rejected ---');
{
  const store = makeStore();
  const areas = ['Solo'];
  store.db.job = { profession: 'Barber', areas, mapsBase: 'https://www.google.com/maps', createdAt: 1 };
  store.db.state = {
    status: 'running', tabId: 7, currentIndex: 0, currentArea: '', expectedUrl: '',
    areas: [{ name: 'Solo', status: 'pending', found: 0, error: '' }],
    config: { delayBetweenAreas: 0, maxScrollSeconds: 12, stableRounds: 2, startDelaySeconds: 0, dedupe: true, stopOnBlocked: false },
    warmedUp: false, navForIndex: -1, heartbeatAt: Date.now(), startedAt: Date.now(), finishedAt: 0, error: ''
  };

  const want = `https://www.google.com/maps/search/${encodeURIComponent('Barber in Solo')}?hl=en`;
  const w = loadPage(store, mapsRewrites(want), mapsPage('Solo', 4));
  w.__setClaim({ go: false });          /* pretend we are not the owning tab */

  /* A rejected tab must produce *no* side effects at all - no heartbeat, no
     status change, no rows. Snapshot the whole state and watch it for long
     enough that an accepted tab would definitely have shown itself. */
  const snap = () => JSON.stringify({
    s: store.db.state.status,
    i: store.db.state.currentIndex,
    a: store.db.state.areas[0].status,
    h: store.db.state.heartbeatAt,
    d: store.db.areaData === undefined
  });
  const before = snap();
  let mutated = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await sleep(80);
    if (snap() !== before) { mutated = true; break; }
  }

  eq('rejected tab produces no side effects', mutated, false);
  eq('non-owning tab does not advance', store.db.state.currentIndex, 0);
  eq('non-owning tab leaves the area pending', store.db.state.areas[0].status, 'pending');
  eq('non-owning tab does not heartbeat', store.db.state.heartbeatAt, store.db.state.startedAt);
  eq('no data written by the impostor', store.db.areaData, undefined);
}

/* ================================================================== *
 * SCENARIO 4 - a captcha wall parks the job instead of burning the queue
 * ================================================================== */
console.log('\n--- scenario 4: block detection pauses the run ---');
{
  const store = makeStore();
  const areas = ['Blocked'];
  store.db.job = { profession: 'Cafe', areas, mapsBase: 'https://www.google.com/maps', createdAt: 1 };
  store.db.state = {
    status: 'running', tabId: 7, currentIndex: 0, currentArea: '', expectedUrl: '',
    areas: [{ name: 'Blocked', status: 'pending', found: 0, error: '' }],
    config: { delayBetweenAreas: 0, maxScrollSeconds: 12, stableRounds: 2, startDelaySeconds: 0, dedupe: true, stopOnBlocked: true },
    warmedUp: false, navForIndex: -1, heartbeatAt: Date.now(), startedAt: Date.now(), finishedAt: 0, error: ''
  };

  const want = `https://www.google.com/maps/search/${encodeURIComponent('Cafe in Blocked')}?hl=en`;
  const wall = '<!doctype html><html><body><p>Our systems have detected unusual traffic from your computer network.</p></body></html>';
  loadPage(store, mapsRewrites(want), wall);

  await waitFor(async () => store.db.state.status === 'paused', 'the job to pause');
  eq('job paused on a block', store.db.state.status, 'paused');
  eq('blocked area is not advanced past', store.db.state.currentIndex, 0);
  eq('blocked area recorded as error', store.db.state.areas[0].status, 'error');
  eq('error explains why', /Blocked by Google/.test(store.db.state.areas[0].error), true);

  /* --- and Resume picks it back up from the same index --- */
  store.db.state.status = 'running';
  store.db.state.areas[0] = { name: 'Blocked', status: 'pending', found: 0, error: '' };
  await store.local.set({ state: store.db.state });
  loadPage(store, mapsRewrites(want), mapsPage('Blocked', 2));
  await waitFor(async () => store.db.state.status === 'done', 'the resumed run to finish');
  eq('resume completes the same area', store.db.state.status, 'done');
  eq('resumed area collected its results', store.db.state.areas[0].found, 2);
}

/* ================================================================== *
 * SCENARIO 5 - an external pause interrupts an in-flight scrape
 * ================================================================== */
console.log('\n--- scenario 5: pause interrupts an in-flight area ---');
{
  const store = makeStore();
  const areas = ['Slow'];
  store.db.job = { profession: 'Spa', areas, mapsBase: 'https://www.google.com/maps', createdAt: 1 };
  store.db.state = {
    status: 'running', tabId: 7, currentIndex: 0, currentArea: '', expectedUrl: '',
    areas: [{ name: 'Slow', status: 'pending', found: 0, error: '' }],
    /* a long budget: without a live status mirror this area would keep
       scrolling for minutes after the user pressed Pause */
    config: { delayBetweenAreas: 0, maxScrollSeconds: 300, stableRounds: 50, startDelaySeconds: 0, dedupe: true, stopOnBlocked: false },
    warmedUp: false, navForIndex: -1, heartbeatAt: Date.now(), startedAt: Date.now(), finishedAt: 0, error: ''
  };

  const want = `https://www.google.com/maps/search/${encodeURIComponent('Spa in Slow')}?hl=en`;
  loadPage(store, mapsRewrites(want), mapsPage('Slow', 6, 0));

  /* wait until the area is actually being scraped */
  await waitFor(async () => store.db.state.areas[0].status === 'running', 'the area to start');
  ok('the scraper registered a change listener', store.listenerCount() > 0);

  /* The popup pressed Pause: the background writes state, and the content
     script must notice through storage.onChanged rather than waiting for the
     navigation - the area has a 300s scroll budget it would otherwise use. */
  const t0 = Date.now();
  const st = store.db.state;
  st.status = 'paused';
  st.currentArea = '';
  await store.local.set({ state: st });

  /* the scraper unwinds: it parks the area and returns without finishing it */
  await waitFor(async () => store.db.state.areas[0].status === 'pending', 'the area to be re-queued', 15000);

  eq('the paused area is put back in the queue', store.db.state.areas[0].status, 'pending');
  eq('the index did not advance', store.db.state.currentIndex, 0);
  eq('status is still paused', store.db.state.status, 'paused');
  ok('pause unwound well inside the scroll budget', Date.now() - t0 < 15000);
  eq('the change listener is removed on exit', store.listenerCount(), 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
