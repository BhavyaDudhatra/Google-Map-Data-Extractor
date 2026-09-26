const JobKeys = {
  job: 'gme_job',
  meta: 'gme_rec_meta',
  pendingStart: 'gme_pending_start'
};

function batchKey(jobId, index) {
  return 'gme_rec_batch_' + jobId + '_' + index;
}

const Runner = (function () {
  let job = null;
  let seenSet = new Set();
  let pendingBatch = [];
  let persistTimer = null;
  let areaRunInProgress = false;
  let broadcastTimer = null;
  let lastBatchIndex = -1;
  let areaProcessed = new Set();

  function emptyJob() {
    return {
      version: 1,
      jobId: '',
      status: 'idle',
      areas: [],
      profession: '',
      totalAreas: 0,
      areaIndex: 0,
      currentArea: '',
      currentSearch: '',
      scrollRound: 0,
      areaCollected: 0,
      resultsFound: 0,
      pageProcessed: 0,
      pageTotal: 0,
      temporarilyClosedSkipped: 0,
      statusDetail: '',
      totalRecords: 0,
      duplicatesRemoved: 0,
      error: '',
      startedAt: '',
      updatedAt: ''
    };
  }

  function makeJobId() {
    return 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function persistNow() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!job) return;
    job.updatedAt = nowIso();
    const snapshot = JSON.parse(JSON.stringify(job));
    chrome.storage.local.set({ [JobKeys.job]: snapshot });
    scheduleBroadcast();
  }

  function persistSoon(delay) {
    const wait = delay || 900;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      persistTimer = null;
      persistNow();
    }, wait);
  }

  function scheduleBroadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(function () {
      broadcastTimer = null;
      broadcastUpdate({}, 'UPDATE');
    }, 600);
  }

  function broadcastUpdate(extra, kind) {
    const payload = Object.assign({ type: 'GME_STATE', state: jobStateSnapshot() }, extra);
    try {
      chrome.runtime.sendMessage(payload);
    } catch (error) {}
  }

  function jobStateSnapshot() {
    if (!job) return null;
    return {
      status: job.status,
      totalAreas: job.totalAreas,
      areaIndex: job.areaIndex,
      currentArea: job.currentArea,
      currentSearch: job.currentSearch,
      scrollRound: job.scrollRound,
      areaCollected: job.areaCollected,
      resultsFound: job.resultsFound,
      pageProcessed: job.pageProcessed || 0,
      pageTotal: job.pageTotal || 0,
      temporarilyClosedSkipped: job.temporarilyClosedSkipped || 0,
      statusDetail: job.statusDetail || '',
      totalRecords: job.totalRecords,
      duplicatesRemoved: job.duplicatesRemoved,
      profession: job.profession,
      error: job.error,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt
    };
  }

  function setStatusDetail(text) {
    if (!job || job.statusDetail === text) return;
    job.statusDetail = text;
    persistSoon(400);
  }

  function loadFromStorage() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(JobKeys.job, function (result) {
        const stored = result && result[JobKeys.job];
        if (stored && stored.version === 1) {
          job = Object.assign(emptyJob(), stored);
          job.areas = Array.isArray(stored.areas) ? stored.areas : [];
        } else if (stored && stored.version !== 1) {
          job = Object.assign(emptyJob(), stored);
        } else {
          job = emptyJob();
        }
        resolve(job);
      });
    });
  }

  function getAllRecordKeys() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(null, function (all) {
        if (!all) {
          resolve([]);
          return;
        }
        const prefix = job && job.jobId ? 'gme_rec_batch_' + job.jobId + '_' : 'gme_rec_batch_';
        const keys = Object.keys(all).filter(function (k) { return k.indexOf(prefix) === 0; });
        keys.sort(function (a, b) {
          const na = Number(a.split('_').pop());
          const nb = Number(b.split('_').pop());
          return na - nb;
        });
        resolve(keys);
      });
    });
  }

  function loadJobRecords() {
    return new Promise(function (resolve) {
      getAllRecordKeys().then(function (keys) {
        if (!keys.length) {
          resolve([]);
          return;
        }
        chrome.storage.local.get(keys, function (result) {
          const records = [];
          for (const key of keys) {
            const batch = result[key];
            if (Array.isArray(batch)) records.push.apply(records, batch);
          }
          resolve(records);
        });
      });
    });
  }

  function rebuildSeenSet() {
    return loadJobRecords().then(function (records) {
      seenSet = new Set();
      let stored = 0;
      for (const rec of records) {
        if (!rec || !rec.name) continue;
        stored++;
        const key = dedupeKey(rec);
        if (key) seenSet.add(key);
      }
      return { stored: stored, unique: seenSet.size };
    });
  }

  function commitBatchNow() {
    return new Promise(function (resolve) {
      if (!pendingBatch.length) {
        resolve();
        return;
      }
      const jobId = job ? job.jobId : 'standalone';
      const batch = pendingBatch.slice();
      pendingBatch = [];
      chrome.storage.local.get(JobKeys.meta, function (result) {
        const meta = result && result[JobKeys.meta] ? result[JobKeys.meta] : { jobId: jobId, batchCount: 0, total: 0 };
        if (!meta.jobId) meta.jobId = jobId;
        const index = meta.batchCount;
        meta.batchCount += 1;
        meta.total += batch.length;
        lastBatchIndex = index;
        const toStore = {};
        toStore[batchKey(jobId, index)] = batch;
        toStore[JobKeys.meta] = meta;
        chrome.storage.local.set(toStore, function () {
          resolve();
        });
      });
    });
  }

  let flushQueue = Promise.resolve();

  function flushAndWait() {
    if (pendingBatch.length) {
      flushQueue = flushQueue.then(function () {
        return commitBatchNow();
      }).catch(function () {});
    }
    return flushQueue;
  }

  function saveRecord(record) {
    const key = dedupeKey(record);
    if (key && seenSet.has(key)) {
      job.duplicatesRemoved += 1;
      return false;
    }
    if (key) seenSet.add(key);
    if (!record.name && !record.phone && !record.address && !record.website && !record.fullData) return false;
    pendingBatch.push(record);
    job.areaCollected += 1;
    job.totalRecords += 1;
    job.resultsFound = Math.max(job.resultsFound, job.areaCollected);
    if (pendingBatch.length >= AppLen.flushEvery) {
      flushAndWait();
      persistNow();
    } else {
      persistSoon();
    }
    return true;
  }

  function expectedSearchText() {
    return cleanText(job.profession + ' in ' + job.currentArea);
  }

  function ensureAreaSearchPage() {
    if (!job || !job.areas || job.areaIndex >= job.areas.length) return Promise.resolve(false);
    const current = currentSearchTextFromUrl();
    if (current === expectedSearchText()) {
      return Promise.resolve(true);
    }
    persistNow();
    navigateTo(buildSearchUrl(job.profession, job.currentArea));
    return Promise.resolve(false);
  }

  function dismissPromptsAndDialogs() {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (!dialog) return;
    const buttons = dialog.querySelectorAll('button');
    let closedSomething = false;
    for (const button of buttons) {
      const label = cleanText(button.getAttribute('aria-label') || button.innerText || '');
      if (/dismiss|close|no thanks/i.test(label) && button.offsetParent !== null) {
        clickElement(button);
        closedSomething = true;
      }
    }
    if (!closedSomething) {
      for (const button of buttons) {
        if (/accept all|i agree|got it/i.test(cleanText(button.innerText || '')) && button.offsetParent !== null) {
          clickElement(button);
          break;
        }
      }
    }
  }

  function preparePage() {
    dismissPromptsAndDialogs();
  }

  function runArea() {
    if (areaRunInProgress) return;
    if (!job || job.status !== 'running') return;
    areaRunInProgress = true;
    Promise.resolve()
      .then(ensureAreaSearchPage)
      .then(function (onRightPage) {
        if (!onRightPage) return null;
        if (job.status !== 'running') return null;
        preparePage();
        return extractCurrentArea();
      })
      .catch(function (error) {
        handleAreaError(error);
      })
      .then(function () {
        areaRunInProgress = false;
      });
  }

  async function extractCurrentArea() {
    job.areaCollected = 0;
    job.resultsFound = 0;
    job.scrollRound = 1;
    job.pageProcessed = 0;
    job.pageTotal = 0;
    job.currentSearch = expectedSearchText();
    areaProcessed = new Set();
    setStatusDetail('Loading results for ' + job.currentArea + '...');
    persistNow();

    const feedResult = await waitForFeed(35000);
    if (!feedResult || !feedResult.feed) {
      if (isBlockedPage()) {
        setErrorState('Google is blocking the page (captcha, consent or unusual traffic). Open Google Maps manually and try again.');
        return;
      }
      if (isGoogleMapsPage() && isNoResultsPage()) {
        await finishArea();
        return;
      }
      setErrorState('Search results did not load in time for: ' + job.currentArea);
      return;
    }

    preparePage();
    const headingCount = readResultCountFromPage();
    if (headingCount) job.resultsFound = headingCount;
    setStatusDetail('Processing page 1 of results for ' + job.currentArea + '...');
    persistNow();

    let loopSafety = 0;
    while (job.status === 'running') {
      const currentFeed = getFeedElement();
      if (!currentFeed) {
        setErrorState('The results list disappeared while extracting: ' + job.currentArea);
        return;
      }
      await extractArticlesBatch(currentFeed);
      if (job.status !== 'running') break;
      persistNow();

      const result = await advanceToNextResultSet();
      if (job.status !== 'running') break;
      if (!result) break;
      if (result.advanced) {
        job.scrollRound += 1;
        setStatusDetail('Processing page ' + job.scrollRound + ' of results for ' + job.currentArea + '...');
        persistNow();
      }
      loopSafety += 1;
      if (loopSafety > AppLen.scrollMaxRounds) break;
    }
    persistNow();
    if (job.status === 'running') {
      await finishArea();
    }
  }

  async function extractArticlesBatch(feed) {
    if (!feed) return false;
    const articles = getArticleElements(feed);
    const fresh = [];
    for (const article of articles) {
      const identity = articleIdentity(article);
      if (!areaProcessed.has(identity)) fresh.push(article);
    }
    job.pageTotal = fresh.length;
    job.pageProcessed = 0;
    if (fresh.length && job.status === 'running') {
      setStatusDetail('Processing page ' + job.scrollRound + ' \u2014 ' + job.pageProcessed + ' / ' + job.pageTotal + ' for ' + job.currentArea + '...');
    }
    for (const article of fresh) {
      if (job.status !== 'running') break;
      const identity = articleIdentity(article);
      if (areaProcessed.has(identity)) continue;
      areaProcessed.add(identity);
      await extractArticle(article);
      job.pageProcessed += 1;
      if (job.status === 'running') {
        setStatusDetail('Processing page ' + job.scrollRound + ' \u2014 ' + job.pageProcessed + ' / ' + job.pageTotal + ' for ' + job.currentArea + '...');
      }
      persistSoon(200);
    }
    return fresh.length > 0;
  }

  async function extractArticle(article) {
    if (elementHasTemporarilyClosed(article)) {
      job.temporarilyClosedSkipped = (job.temporarilyClosedSkipped || 0) + 1;
      persistSoon(300);
      return;
    }

    const base = extractFromFeedItem(article);
    const link = extractFeedLink(article);
    const previousName = extractNameFromPage();

    let clicked = false;
    for (let attempt = 0; attempt < AppLen.articleRetryCount; attempt++) {
      if (job.status !== 'running') break;
      if (link) clicked = clickElement(link);
      else if (article) clicked = clickElement(article);
      if (!clicked) break;
      const settled = await waitForPanelChange(previousName, 9000);
      if (settled) {
        clicked = true;
        break;
      }
      clicked = false;
    }

    let detail = null;
    if (clicked && job.status === 'running') {
      const probe = await waitForDetailPanel(14000);
      if (probe) await settlePanelInfo();
      detail = extractFromDetailPanel(document);
    }

    let fullData = '';
    if (detail && clicked && job.status === 'running') {
      fullData = extractFullPanelText();
    }

    if (currentPanelHasTemporarilyClosed()) {
      job.temporarilyClosedSkipped = (job.temporarilyClosedSkipped || 0) + 1;
      persistSoon(300);
      return;
    }

    if (!detail) detail = { name: base.name, address: base.address, phone: '' };
    if (!detail.name) detail.name = base.name;
    if (!detail.address) detail.address = base.address;

    const record = {
      area: job.currentArea,
      profession: job.profession,
      name: cleanText(detail.name),
      address: cleanText(detail.address),
      phone: cleanText(detail.phone),
      website: cleanText(detail.website),
      rating: cleanText(detail.rating),
      reviews: cleanText(detail.reviews),
      hours: cleanText(detail.hours),
      plusCode: cleanText(detail.plusCode),
      category: cleanText(detail.category),
      priceLevel: cleanText(detail.priceLevel),
      url: base.url || '',
      fullData: fullData
    };
    saveRecord(record);
  }

  function extractNameFromPage() {
    const nodes = findIn(document, MapsDom.detailName);
    for (const node of nodes) {
      const text = cleanText(node.getAttribute('aria-label') || node.innerText || '');
      if (text) return text;
    }
    return '';
  }

  function waitForPanelChange(previousName, timeout) {
    return waitFor(function () {
      const heading = findIn(document, MapsDom.detailName);
      for (const node of heading) {
        const text = cleanText(node.getAttribute('aria-label') || node.innerText || '');
        if (text && (!previousName || text !== previousName)) return true;
      }
      const direct = document.querySelector('h1');
      if (direct) {
        const text = cleanText(direct.innerText || '');
        if (text && (!previousName || text !== previousName)) return true;
      }
      return null;
    }, { timeout: timeout || 12000, interval: 300 });
  }

  function waitForDetailFields(timeout) {
    return waitFor(function () {
      if (hasAnyDetailField(document)) return true;
      return null;
    }, { timeout: timeout || 4500, interval: 350 });
  }

  function currentPanelHasTemporarilyClosed() {
    const heading = findIn(document, MapsDom.detailName);
    if (heading.length) {
      const ctx = heading[0].parentElement;
      if (ctx && containsTemporarilyClosed(ctx.innerText || '')) return true;
    }
    const main = document.querySelector(MapsDom.panelRoot);
    if (main && containsTemporarilyClosed(main.innerText || '')) return true;
    return containsTemporarilyClosed(document.body.innerText || '');
  }

  async function settlePanelInfo() {
    if (await waitForDetailFields(4000)) return;
    openInfoTabIfPresent();
    if (await waitForDetailFields(3500)) return;
    clickMoreActionIfPresent();
    if (await waitForDetailFields(3000)) return;
    openInfoTabIfPresent();
    await waitForDetailFields(2500);
  }

  async function advanceToNextResultSet() {
    const feed = getFeedElement();
    if (!feed) return false;
    const beforeSet = currentArticleIdentities(feed);

    scrollFeedBottom(feed);
    const quickExtra = await waitForArticleSetChange(beforeSet, 1500);
    if (quickExtra) {
      await waitForFeedSettled(6000);
      scrollFeedBottom(feed);
      return { more: true, advanced: false };
    }

    const initialNext = nextPageButtonState();
    if (initialNext.exists && initialNext.enabled) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (job.status !== 'running') return false;
        const state = nextPageButtonState();
        if (!state.exists || !state.enabled) break;
        const clicked = clickElement(state.node);
        if (!clicked) continue;
        const changed = await waitForArticleSetChange(beforeSet, AppLen.nextPageWaitMs);
        if (changed) {
          await waitForFeedSettled(8000);
          scrollFeedBottom(feed);
          return { more: true, advanced: true };
        }
      }
      const afterState = nextPageButtonState();
      if (!afterState.exists || !afterState.enabled) {
        const late = await waitForArticleSetChange(beforeSet, 8000);
        if (late) {
          scrollFeedBottom(feed);
          return { more: true, advanced: true };
        }
        return false;
      }
    }

    for (let attempt = 0; attempt < AppLen.emptyScrollRetries; attempt++) {
      if (job.status !== 'running') return false;
      scrollFeedBottom(feed);
      const added = await waitForArticleSetChange(beforeSet, 4500);
      if (added) {
        await waitForFeedSettled(6000);
        scrollFeedBottom(feed);
        return { more: true, advanced: false };
      }
    }
    return false;
  }

  async function finishArea() {
    if (!job) return;
    await flushAndWait();
    recordAreaSummary();
    job.areaIndex += 1;
    if (job.areaIndex >= job.areas.length) {
      await finishAll();
      return;
    }
    job.currentArea = job.areas[job.areaIndex];
    job.currentSearch = expectedSearchText();
    job.scrollRound = 0;
    job.areaCollected = 0;
    job.resultsFound = 0;
    job.pageProcessed = 0;
    job.pageTotal = 0;
    setStatusDetail('Moving to next area...');
    persistNow();
    navigateTo(buildSearchUrl(job.profession, job.currentArea));
  }
    function recordAreaSummary() {
    const key = 'gme_area_stats';
    const entry = {
      area: job.currentArea,
      extracted: job.areaCollected,
      rounds: job.scrollRound,
      at: nowIso()
    };
    chrome.storage.local.get(key, function (result) {
      const list = result && result[key] ? result[key] : [];
      list.push(entry);
      chrome.storage.local.set({ [key]: list });
    });
  }

  async function finishAll() {
    await flushAndWait();
    job.status = 'completed';
    job.currentSearch = '';
    job.statusDetail = '';
    persistNow();
    broadcastUpdate({ finished: true }, 'FINISHED');
    try {
      chrome.runtime.sendMessage({ type: 'GME_FINISHED', state: jobStateSnapshot() });
    } catch (error) {}
  }

  function setErrorState(message) {
    if (!job) return;
    job.status = 'error';
    job.error = message || 'Unexpected error during extraction.';
    job.statusDetail = job.error;
    persistNow();
    broadcastUpdate({}, 'ERROR');
    try {
      chrome.runtime.sendMessage({ type: 'GME_ERROR', state: jobStateSnapshot(), message: job.error });
    } catch (error) {}
  }

  function handleAreaError(error) {
    const message = error && error.message ? error.message : String(error);
    if (!job) return;
    job.error = message;
    persistNow();
    setErrorState(message);
  }

  function refreshFromStorageBeforeControl() {
    return loadFromStorage();
  }

  function startJob(payload) {
    const areas = (payload.areas || []).filter(Boolean).map(function (a) { return cleanText(a); }).filter(Boolean);
    const profession = cleanText(payload.profession || '');
    if (!areas.length || !profession) {
      return Promise.resolve({ ok: false, reason: 'Areas and profession are required.' });
    }
    if (areas.length > AppLen.maxAreas) {
      return Promise.resolve({ ok: false, reason: 'Maximum ' + AppLen.maxAreas + ' areas allowed.' });
    }
    const newJob = emptyJob();
    newJob.jobId = makeJobId();
    newJob.status = 'running';
    newJob.areas = areas.slice();
    newJob.profession = profession;
    newJob.totalAreas = areas.length;
    newJob.areaIndex = 0;
    newJob.currentArea = areas[0];
    newJob.currentSearch = cleanText(profession + ' in ' + areas[0]);
    newJob.startedAt = nowIso();
    newJob.updatedAt = nowIso();
    job = newJob;
    seenSet = new Set();
    pendingBatch = [];
    areaProcessed = new Set();
    lastBatchIndex = -1;
    areaRunInProgress = false;
    setStatusDetail('Starting job...');
    persistNow();
    return loadThenMaybeStart();
  }

  function loadThenMaybeStart() {
    return Promise.resolve().then(function () {
      return refreshFromStorageBeforeControl();
    }).then(function () {
      if (!job || job.status !== 'running') return { ok: false, reason: 'Job not active.' };
      runArea();
      return { ok: true };
    });
  }

  function pauseJob() {
    if (!job) return { ok: true, status: 'idle' };
    job.status = 'paused';
    setStatusDetail('Paused.');
    persistNow();
    return { ok: true, status: 'paused' };
  }

  function resumeJob() {
    return Promise.resolve().then(function () {
      if (!job) return { ok: false, status: 'idle' };
      if (seenSet.size === 0) {
        return rebuildSeenSet().then(function () {
          if (!job || job.status === 'stopped') return { ok: false, status: job ? job.status : 'idle' };
          job.status = 'running';
          setStatusDetail('Resuming...');
          persistNow();
          runArea();
          return { ok: true, status: 'running' };
        });
      }
      job.status = 'running';
      setStatusDetail('Resuming...');
      persistNow();
      runArea();
      return { ok: true, status: 'running' };
    });
  }

  function stopJob() {
    if (!job) return { ok: true, status: 'idle' };
    job.status = 'stopped';
    setStatusDetail('Stopped.');
    persistNow();
    return { ok: true, status: 'stopped' };
  }

  function resetJob() {
    job = emptyJob();
    seenSet = new Set();
    pendingBatch = [];
    setStatusDetail('');
    persistNow();
    return { ok: true, status: 'idle' };
  }

  function onPageReady() {
    return loadFromStorage().then(function (loadedJob) {
      if (!loadedJob || (loadedJob.status !== 'running' && loadedJob.status !== 'paused')) {
        return null;
      }
      if (loadedJob.areaIndex >= loadedJob.areas.length) {
        job.status = 'completed';
        persistNow();
        return null;
      }
      return rebuildSeenSet().then(function () {
        if (!job || (job.status !== 'running' && job.status !== 'paused')) return null;
        const current = currentSearchTextFromUrl();
        const expected = expectedSearchText();
        if (current !== expected) {
          setStatusDetail('Loading results for ' + job.currentArea + '...');
          persistNow();
          navigateTo(buildSearchUrl(job.profession, job.currentArea));
          return null;
        }
        if (job.status === 'paused') return null;
        setStatusDetail('Continuing extraction...');
        persistNow();
        runArea();
        return null;
      });
    });
  }

  function getStateSummary() {
    return jobStateSnapshot();
  }

  function getRecordCount() {
    if (!job) return Promise.resolve(0);
    return Promise.resolve(job.totalRecords);
  }

  return {
    startJob: startJob,
    pauseJob: pauseJob,
    resumeJob: resumeJob,
    stopJob: stopJob,
    resetJob: resetJob,
    onPageReady: onPageReady,
    getStateSummary: getStateSummary,
    getRecordCount: getRecordCount,
    persistNow: persistNow,
    rebuildSeenSet: rebuildSeenSet,
    loadJobRecords: loadJobRecords
  };
})();