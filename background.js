/* Maps Scraper Pro - service worker
 * Deliberately thin: the heavy lifting happens in content.js inside the Maps tab,
 * so Chrome may kill this worker at any time without losing the run.
 * Responsibilities: claim tokens, tab lifecycle, self-healing watchdog, export.
 */
import { mergeAreaData, EXPORT_COLUMNS } from './lib/merge.js';

const S_JOB = 'job';
const S_STATE = 'state';
const S_DATA = 'areaData';
const S_CFG = 'config';

const WATCHDOG = 'gmx-watchdog';
const DYN_SCRIPT_ID = 'gmx-dynamic';
const ICON = 'icons/icon128.png';

const now = () => Date.now();

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
function mapsBaseFor(url) {
  try {
    const u = new URL(url);
    return u.origin + '/maps';
  } catch (_) {
    return 'https://www.google.com/maps';
  }
}

function dedupeAreas(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const name = String(raw).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: ICON,
      title,
      message,
      priority: 1
    });
  } catch (_) {}
}

/* Register a content script for every extra Google TLD the user granted, so the
 * scraper is present on the very first paint of each Maps page load. */
async function syncDynamicScripts() {
  try {
    const granted = await chrome.permissions.getAll();
    const primary = 'https://www.google.com/maps/*';
    const extra = (granted.origins || []).filter(
      (o) => o !== primary && /^https:\/\/(www\.)?google\.[a-z.]{2,6}\/maps\/\*$/.test(o)
    );
    const matches = [...new Set(extra)];
    if (!matches.length) return;
    try { await chrome.scripting.unregisterContentScripts({ ids: [DYN_SCRIPT_ID] }); } catch (_) {}
    await chrome.scripting.registerContentScripts([
      {
        id: DYN_SCRIPT_ID,
        matches,
        js: ['content.js'],
        runAt: 'document_start',
        allFrames: false
      }
    ]);
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * messages
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  /* Every path must call sendResponse. Because we return `true` below, a
   * throw that skipped it would leave the sender's promise pending forever
   * (the popup's .catch cannot help - it would never reject). */
  (async () => {
    switch (msg && msg.type) {
      case 'CLAIM': {
        const { state } = await chrome.storage.local.get(S_STATE);
        const tabId = sender && sender.tab ? sender.tab.id : -1;
        const go = !!(state && state.tabId === tabId);
        sendResponse({ go, expectedUrl: state ? state.expectedUrl : '' });
        return;
      }

      case 'START_JOB':
        sendResponse(await startJob(msg.payload));
        return;

      case 'PAUSE_JOB':
        sendResponse(await pauseJob());
        return;

      case 'STOP_JOB':
        sendResponse(await stopJob());
        return;

      case 'RESUME_JOB':
        sendResponse(await resumeJob());
        return;

      case 'SKIP_AREA':
        sendResponse(await skipArea(msg.index));
        return;

      case 'CLEAR_JOB':
        sendResponse(await clearJob());
        return;

      case 'JOB_FINISHED': {
        const { state } = await chrome.storage.local.get(S_STATE);
        const rows = (state && Array.isArray(state.areas)) ? state.areas : [];
        const found = rows.reduce((a, x) => a + (x.found || 0), 0);
        await notify('Scrape complete', `Finished all areas. ${found} results collected. Open the extension to download the Excel file.`);
        return;
      }

      case 'JOB_PAUSED':
        await notify('Scrape paused', `Google asked for a human check on "${msg.area}". Solve it in the Maps tab, then press Resume.`);
        return;

      case 'EXPORT_ROWS': {
        const { state, areaData, job } = await chrome.storage.local.get([S_STATE, S_DATA, S_JOB]);
        if (!state || !Array.isArray(state.areas)) { sendResponse({ error: 'No job data found.' }); return; }
        const areas = state.areas;
        const merged = mergeAreaData(areas, areaData || {}, !state.config || state.config.dedupe !== false);
        merged.meta = {
          profession: job ? job.profession : '',
          startedAt: state.startedAt || 0,
          finishedAt: state.finishedAt || 0,
          areaCount: areas.length,
          doneCount: areas.filter((a) => a.status === 'done' || a.status === 'empty').length,
          failedCount: areas.filter((a) => a.status === 'error').length,
          emptyCount: areas.filter((a) => a.status === 'empty').length
        };
        sendResponse({ rows: merged.rows, duplicates: merged.duplicates, columns: EXPORT_COLUMNS, meta: merged.meta });
        return;
      }

      default:
        sendResponse({ error: 'Unknown message' });
    }
  })().catch((err) => {
    try { sendResponse({ error: String((err && err.message) || err) }); } catch (_) {}
  });
  return true; /* keep the message channel open for the async reply */
});

/* ------------------------------------------------------------------ *
 * job control
 * ------------------------------------------------------------------ */
async function startJob(payload) {
  const p = payload || {};
  const areas = dedupeAreas(Array.isArray(p.areas) ? p.areas : []);
  const profession = String(p.profession || '').trim();
  if (!profession) return { error: 'Profession is required.' };
  if (!areas.length) return { error: 'At least one area name is required.' };
  if (areas.length > 1000) return { error: 'Maximum 1000 areas per run.' };

  const hasMaps = await chrome.permissions.contains({ origins: [mapsBaseFor(p.mapsUrl) + '/*'] });
  if (!hasMaps) return { needsPermission: mapsBaseFor(p.mapsUrl) + '/*' };

  const base = mapsBaseFor(p.mapsUrl);
  await syncDynamicScripts();

  const areaRows = areas.map((name) => ({ name, status: 'pending', found: 0, error: '' }));
  const state = {
    status: 'paused',            /* stays inert until the tab id is known */
    tabId: null,
    currentIndex: 0,
    currentArea: '',
    expectedUrl: '',
    areas: areaRows,
    config: p.config || {},
    warmedUp: false,
    navForIndex: -1,
    heartbeatAt: now(),
    startedAt: now(),
    finishedAt: 0,
    error: ''
  };

  await chrome.storage.local.set({
    [S_JOB]: { profession, areas, mapsBase: base, createdAt: now() },
    [S_STATE]: state,
    [S_DATA]: {}
  });

  chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });

  /* The content script sends CLAIM at document_start. It must find its own tab
     id already in storage, so create the tab blank, record the id, then point
     it at the search - otherwise the first area idles until the watchdog fires. */
  const blank = await chrome.tabs.create({ url: 'about:blank', active: true });
  state.tabId = blank.id;
  state.status = 'running';
  await chrome.storage.local.set({ [S_STATE]: state });
  await chrome.tabs.update(blank.id, {
    url: `${base}/search/${encodeURIComponent(`${profession} in ${areas[0]}`)}?hl=en`
  }).catch(() => {});

  return { ok: true, tabId: blank.id, total: areas.length };
}

/* Both Pause and Stop only move `status`; the popup and content script own the
   per-area bookkeeping. Nothing is ever cancelled or discarded here, so
   Resume can always pick the queue back up exactly where it left off. */
async function haltJob(finalStatus) {
  const { state } = await chrome.storage.local.get(S_STATE);
  if (!state) return { error: 'Nothing running.' };
  if (state.status === 'done' || state.status === 'idle') return { ok: true, already: true };

  state.status = finalStatus;
  state.currentArea = '';
  state.navForIndex = -1;
  await chrome.storage.local.set({ [S_STATE]: state });
  return { ok: true };
}

async function pauseJob() {
  return haltJob('paused');
}

async function stopJob() {
  return haltJob('stopped');
}

async function resumeJob() {
  const { state } = await chrome.storage.local.get(S_STATE);
  if (!state) return { error: 'No job to resume.' };
  if (state.status === 'done' || state.status === 'idle') return { error: 'Nothing to resume.' };
  if (state.status === 'running') return { ok: true, already: true };

  state.status = 'running';
  state.error = '';
  state.navForIndex = -1;
  state.heartbeatAt = now();
  /* an area left mid-flight goes back in the queue so nothing is silently lost */
  state.areas = state.areas.map((a) =>
    a.status === 'running' ? Object.assign({}, a, { status: 'pending' }) : a
  );
  await chrome.storage.local.set({ [S_STATE]: state });
  /* the content script already exited when we paused - bounce the tab to restart it */
  await ensureTabFromState(true);
  return { ok: true };
}

async function skipArea(index) {
  const { state } = await chrome.storage.local.get(S_STATE);
  if (!state || !state.areas[index]) return { error: 'Invalid area.' };
  state.areas[index] = Object.assign({}, state.areas[index], { status: 'skipped' });
  if (index === state.currentIndex && (state.status === 'paused' || state.status === 'stopped')) {
    state.currentIndex = index + 1;
    state.status = 'running';
    state.navForIndex = -1;
  }
  await chrome.storage.local.set({ [S_STATE]: state });
  if (state.status === 'running') await ensureTabFromState();
  return { ok: true };
}

async function clearJob() {
  chrome.alarms.clear(WATCHDOG);
  const { state } = await chrome.storage.local.get(S_STATE);
  await chrome.storage.local.remove([S_JOB, S_STATE, S_DATA]);
  if (state && state.tabId != null) {
    chrome.tabs.remove(state.tabId).catch(() => {});
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * tab management
 * ------------------------------------------------------------------ */
async function ensureTab(mapsBase, query, forceNew, bust) {
  const { state, job } = await chrome.storage.local.get([S_STATE, S_JOB]);
  const base = mapsBase || (job ? job.mapsBase : mapsBaseFor('https://www.google.com/maps'));
  const q = query || (job && state ? `${job.profession} in ${job.areas[state.currentIndex] || job.areas[0]}` : '');
  const url = `${base}/search/${encodeURIComponent(q)}?hl=en`;

  if (!forceNew && state && state.tabId != null) {
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (tab) {
      state.tabId = tab.id;
      state.expectedUrl = url;
      /* The page keeps its own pathname when we add a cache-busting param, so the
         content script resumes on the same area instead of navigating again. */
      if (bust) await chrome.tabs.update(tab.id, { url: `${url}&r=${now()}`, active: true }).catch(() => {});
      await chrome.storage.local.set({ [S_STATE]: state });
      return tab;
    }
  }

  /* reuse an idle Maps tab instead of piling up new ones */
  let tab = null;
  if (!forceNew) {
    const tabs = await chrome.tabs.query({ url: base + '/*' }).catch(() => []);
    if (tabs && tabs.length) tab = tabs[0];
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: true });
  } else {
    await chrome.tabs.update(tab.id, { url, active: true });
  }
  const fresh = await chrome.storage.local.get(S_STATE);
  if (fresh[S_STATE]) {
    fresh[S_STATE].tabId = tab.id;
    fresh[S_STATE].expectedUrl = url;
    fresh[S_STATE].heartbeatAt = now();
    await chrome.storage.local.set({ [S_STATE]: fresh[S_STATE] });
  }
  return tab;
}

async function ensureTabFromState(bust) {
  const { state, job } = await chrome.storage.local.get([S_STATE, S_JOB]);
  if (!state || !job) return null;
  const area = job.areas[state.currentIndex];
  if (area == null) return null;
  return ensureTab(job.mapsBase, `${job.profession} in ${area}`, false, bust);
}

/* ------------------------------------------------------------------ *
 * self-healing watchdog
 * ------------------------------------------------------------------ */
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== WATCHDOG) return;
  (async () => {
    const { state, job } = await chrome.storage.local.get([S_STATE, S_JOB]);
    if (!state || !job) return;
    if (state.status !== 'running' && state.status !== 'paused') {
      if (state.status === 'done' || state.status === 'stopped') chrome.alarms.clear(WATCHDOG);
      return;
    }

    const area = job.areas[state.currentIndex];
    if (area == null) return;
    const want = `${job.mapsBase}/search/${encodeURIComponent(job.profession + ' in ' + area)}?hl=en`;

    let tab = state.tabId != null ? await chrome.tabs.get(state.tabId).catch(() => null) : null;
    if (!tab) {
      await ensureTab(job.mapsBase, `${job.profession} in ${area}`, true);
      return;
    }

    if (state.status === 'paused') {
      state.heartbeatAt = now();
      await chrome.storage.local.set({ [S_STATE]: state });
      return;
    }

    const stale = now() - (state.heartbeatAt || 0);
    if (stale > 150000) {
      /* the content script is not reporting - force a clean reload */
      await chrome.tabs.update(tab.id, { url: want, active: true });
      state.heartbeatAt = now();
      state.navForIndex = -1;
      await chrome.storage.local.set({ [S_STATE]: state });
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const { state } = await chrome.storage.local.get(S_STATE);
    if (!state || state.tabId !== tabId) return;
    if (state.status === 'running') {
      state.heartbeatAt = now();
      state.navForIndex = -1;
      await chrome.storage.local.set({ [S_STATE]: state });
      await ensureTabFromState();
    } else {
      state.tabId = null;
      await chrome.storage.local.set({ [S_STATE]: state });
    }
  })();
});

/* ------------------------------------------------------------------ *
 * init
 * ------------------------------------------------------------------ */
chrome.runtime.onInstalled.addListener(() => {
  syncDynamicScripts();
});

chrome.runtime.onStartup.addListener(() => {
  syncDynamicScripts();
});

chrome.storage.local.get(S_STATE).then(({ state }) => {
  if (state && (state.status === 'running' || state.status === 'paused')) {
    chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  }
});
