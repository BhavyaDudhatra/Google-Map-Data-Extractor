const UI = (function () {
  const els = {};
  let activeTabId = null;
  let pollTimer = null;

  const XPATH_JOB_KEY = 'gme_job';
  const XPATH_META_KEY = 'gme_rec_meta';
  const XPATH_PENDING_KEY = 'gme_pending_start';
  const STATUS_ORDER = ['idle', 'starting', 'running', 'paused', 'stopped', 'completed', 'error'];

  function grab(id) {
    return document.getElementById(id);
  }

  function initDom() {
    els.areasInput = grab('areasInput');
    els.professionInput = grab('professionInput');
    els.areaCount = grab('areaCount');
    els.startBtn = grab('startBtn');
    els.pauseBtn = grab('pauseBtn');
    els.stopBtn = grab('stopBtn');
    els.exportBtn = grab('exportBtn');
    els.resetBtn = grab('resetBtn');
    els.statusChip = grab('statusChip');
    els.currentArea = grab('currentArea');
    els.areaProgress = grab('areaProgress');
    els.currentSearch = grab('currentSearch');
    els.profession = grab('profession');
    els.resultsFound = grab('resultsFound');
    els.currentPage = grab('currentPage');
    els.totalRecords = grab('totalRecords');
    els.pageProgress = grab('pageProgress');
    els.duplicates = grab('duplicates');
    els.closedSkipped = grab('closedSkipped');
    els.statusDetail = grab('statusDetail');
    els.progressFill = grab('progressFill');
    els.totalProgressText = grab('totalProgressText');
    els.summaryBox = grab('summaryBox');
    els.summaryTitle = grab('summaryTitle');
    els.summaryLines = grab('summaryLines');
    els.pausedHint = grab('pausedHint');
    els.noticeBar = grab('noticeBar');
    els.errorBox = grab('errorBox');
  }

  function parseAreas() {
    const raw = els.areasInput.value || '';
    const seen = new Set();
    const areas = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      const area = line.replace(/\s+/g, ' ').trim();
      if (!area) continue;
      const low = area.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      areas.push(area);
    }
    return areas;
  }

  function getActiveTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
        resolve(tabs && tabs.length ? tabs[0] : null);
      });
    });
  }

  function sendToTab(tabId, message) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(tabId, message, function (response) {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(response || { ok: false });
        });
      } catch (error) {
        resolve({ ok: false, error: String(error) });
      }
    });
  }

  function isMapsUrl(url) {
    if (!url) return false;
    return /^(https:\/\/)?(maps\.google\.com|www\.google\.com\/maps)/i.test(url);
  }

  function setStatusChip(status) {
    const labelMap = {
      idle: 'Idle',
      starting: 'Starting',
      running: 'Running',
      paused: 'Paused',
      stopped: 'Stopped',
      completed: 'Completed',
      error: 'Error'
    };
    els.statusChip.textContent = labelMap[status] || status;
    els.statusChip.className = 'chip chip' + (status.charAt(0).toUpperCase() + status.slice(1));
    els.pausedHint.classList.toggle('hidden', status !== 'paused');
  }

  function renderButtons(status) {
    const running = status === 'running' || status === 'starting';
    const paused = status === 'paused';
    const idle = status === 'idle' || status === 'stopped' || status === 'error' || status === 'completed';

    els.startBtn.disabled = running;
    els.pauseBtn.disabled = !(running || paused);
    els.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    els.stopBtn.disabled = !(running || paused);
    els.exportBtn.disabled = false;
    els.resetBtn.disabled = false;
  }

  function renderSummary(state) {
    if (!state) {
      els.summaryBox.classList.add('hidden');
      return;
    }
    if (state.status === 'completed') {
      els.summaryBox.classList.remove('hidden');
      els.summaryTitle.textContent = 'Extraction Completed';
      els.summaryLines.innerHTML =
        'Completed — <b>' + (state.totalRecords || 0) + ' valid locations collected, ' + (state.temporarilyClosedSkipped || 0) + ' temporarily closed locations skipped.</b><br>' +
        'Areas Completed: <b>' + state.totalAreas + ' / ' + state.totalAreas + '</b><br>' +
        'Duplicates Removed: <b>' + state.duplicatesRemoved + '</b>';
    } else if (state.status === 'stopped') {
      els.summaryBox.classList.remove('hidden');
      els.summaryTitle.textContent = 'Stopped — Data Preserved';
      els.summaryLines.innerHTML =
        'Areas Completed: <b>' + state.areaIndex + ' / ' + state.totalAreas + '</b><br>' +
        'Records Collected: <b>' + state.totalRecords + '</b><br>' +
        'Temporarily Closed Skipped: <b>' + (state.temporarilyClosedSkipped || 0) + '</b><br>' +
        'Duplicates Removed: <b>' + state.duplicatesRemoved + '</b><br>' +
        'You can export the collected data or start a new job.';
    } else if (state.status === 'error') {
      els.summaryBox.classList.remove('hidden');
      els.summaryTitle.textContent = 'Error — Data Preserved';
      els.summaryLines.innerHTML =
        'Records Collected: <b>' + state.totalRecords + '</b><br>' +
        'Duplicates Removed: <b>' + state.duplicatesRemoved + '</b><br><br>' +
        '<i>' + escapeHtml(state.error || 'Unknown error') + '</i>';
    } else {
      els.summaryBox.classList.add('hidden');
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderState(state) {
    if (!state) {
      renderButtons('idle');
      setStatusChip('idle');
      renderSummary(null);
      return;
    }
    const status = state.status || 'idle';
    setStatusChip(status);
    renderButtons(status);
    renderSummary(state);

    els.currentArea.textContent = state.currentArea || '-';
    els.areaProgress.textContent = (state.areaIndex || 0) + ' / ' + (state.totalAreas || 0);
    els.currentSearch.textContent = state.currentSearch || '-';
    els.profession.textContent = state.profession || '-';
    els.resultsFound.textContent = String(state.resultsFound || 0);
    els.currentPage.textContent = String(state.scrollRound || 0);
    els.totalRecords.textContent = String(state.totalRecords || 0);
    els.pageProgress.textContent = (state.pageProcessed || 0) + ' / ' + (state.pageTotal || 0);
    els.duplicates.textContent = String(state.duplicatesRemoved || 0);
    els.closedSkipped.textContent = String(state.temporarilyClosedSkipped || 0);

    const detail = state.statusDetail || '';
    els.statusDetail.textContent = detail;
    els.statusDetail.classList.toggle('hidden', !detail || status === 'idle');

    const total = state.totalAreas || 1;
    const done = Math.min(state.areaIndex, total);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    els.progressFill.style.width = pct + '%';
    els.totalProgressText.textContent = pct + '% \u00b7 ' + done + ' / ' + total + ' areas';
  }

  function showNotice(message) {
    els.noticeBar.textContent = message;
    els.noticeBar.classList.remove('hidden');
  }

  function clearNotice() {
    els.noticeBar.classList.add('hidden');
  }

  function showErrorBox(message) {
    els.errorBox.textContent = message;
    els.errorBox.classList.remove('hidden');
    setTimeout(function () {
      els.errorBox.classList.add('hidden');
    }, 5000);
  }

  function readStorageJob() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(XPATH_JOB_KEY, function (result) {
        const stored = result && result[XPATH_JOB_KEY];
        resolve(stored || {
          status: 'idle',
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
          profession: '',
          error: ''
        });
      });
    });
  }

  async function refreshFromStorage() {
    const job = await readStorageJob();
    renderState(job);
  }

  function start() {
    const areas = parseAreas();
    const profession = els.professionInput.value.replace(/\s+/g, ' ').trim();

    if (areas.length < 1) {
      showErrorBox('Enter at least one area (one per line).');
      return;
    }
    if (areas.length > 1000) {
      showErrorBox('Maximum of 1000 areas allowed.');
      return;
    }
    if (!profession) {
      showErrorBox('Enter the profession / business category.');
      return;
    }

    renderState({ status: 'starting', totalAreas: areas.length, areaIndex: 0 });

    getActiveTab().then(function (tab) {
      if (!tab || !tab.id) {
        showErrorBox('No active tab. Open a tab before starting.');
        return;
      }
      if (isMapsUrl(tab.url)) {
        sendToTab(tab.id, { type: 'GME_START', areas: areas, profession: profession }).then(function (res) {
          if (res && res.ok) {
            clearNotice();
            refreshFromStorage();
          } else if (res && res.reason) {
            showErrorBox(res.reason);
          } else {
            startWithPendingStart(tab, areas, profession);
          }
        });
      } else {
        startWithPendingStart(tab, areas, profession);
      }
    });
  }

  function startWithPendingStart(tab, areas, profession) {
    chrome.storage.local.set({
      [XPATH_PENDING_KEY]: { areas: areas, profession: profession }
    }, function () {
      chrome.tabs.update(tab.id, { url: 'https://www.google.com/maps' }, function () {
        showNotice('Opening Google Maps — extraction will start automatically there.');
      });
    });
  }

  function runControl(command) {
    getActiveTab().then(function (tab) {
      if (!tab || !tab.id || !isMapsUrl(tab.url)) {
        showErrorBox('Open Google Maps in the active tab to control the job.');
        return;
      }
      const types = { pause: 'GME_PAUSE', resume: 'GME_RESUME', stop: 'GME_STOP', reset: 'GME_RESET' };
      sendToTab(tab.id, { type: types[command] }).then(function (res) {
        if (res && res.ok) {
          clearNotice();
          setTimeout(refreshFromStorage, 250);
        } else {
          showErrorBox('Could not send command. The Google Maps tab may still be loading.');
        }
      });
    });
  }

  function startNewJobClicked() {
    readStorageJob().then(function (job) {
      const active = job && (job.status === 'running' || job.status === 'paused');
      if (active) {
        const proceed = window.confirm('A job is currently ' + job.status + '. Start a new job? Collected data of the previous job stays in storage.');
        if (!proceed) return;
      }
      els.areasInput.value = '';
      els.professionInput.value = '';
      renderState({ status: 'idle' });
    });
  }

  function normForDedupe(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function dedupeRecords(records) {
    const seen = new Set();
    const result = [];
    for (const rec of records) {
      const key = [
        normForDedupe(rec.name),
        normForDedupe(rec.phone).replace(/\D/g, ''),
        normForDedupe(rec.address)
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(rec);
    }
    return result;
  }

  function collectRecords() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(null, function (all) {
        if (!all) {
          resolve([]);
          return;
        }
        const job = all[XPATH_JOB_KEY] || {};
        const jobId = job.jobId || (all[XPATH_META_KEY] && all[XPATH_META_KEY].jobId) || '';
        const prefix = jobId ? 'gme_rec_batch_' + jobId + '_' : 'gme_rec_batch_';
        const keys = Object.keys(all).filter(function (k) {
          return k.indexOf(prefix) === 0;
        });
        keys.sort(function (a, b) {
          const na = Number(a.split('_').pop());
          const nb = Number(b.split('_').pop());
          return na - nb;
        });
        const records = [];
        for (const key of keys) {
          const batch = all[key];
          if (Array.isArray(batch)) records.push.apply(records, batch);
        }
        resolve(records);
      });
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  function stamp() {
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function exportExcel() {
    collectRecords().then(function (records) {
      if (!records.length) {
        showErrorBox('No records to export yet.');
        return;
      }
      const cleaned = dedupeRecords(records);
      const rows = cleaned.map(function (rec) {
        return {
          'Area': rec.area || '',
          'Profession': rec.profession || '',
          'Name': rec.name || '',
          'Full Address': rec.address || '',
          'Phone Number': rec.phone || '',
          'Google Maps Link': rec.url || ''
        };
      });

      if (typeof XLSX === 'undefined') {
        exportCsv(rows);
        return;
      }

      const headers = ['Area', 'Profession', 'Name', 'Full Address', 'Phone Number', 'Google Maps Link'];
      const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
      sheet['!cols'] = [
        { wch: 22 }, { wch: 16 }, { wch: 34 }, { wch: 48 }, { wch: 20 }, { wch: 58 }
      ];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, 'Business Data');

      const out = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      downloadBlob(blob, 'google_maps_data_' + stamp() + '.xlsx');
    });
  }

  function exportCsv(rows) {
    const headers = ['Area', 'Profession', 'Name', 'Full Address', 'Phone Number', 'Google Maps Link'];
    const escapeCell = function (v) {
      const s = String(v || '');
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const lines = [headers.map(escapeCell).join(',')];
    for (const row of rows) {
      lines.push(headers.map(function (h) { return escapeCell(row[h]); }).join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, 'google_maps_data_' + stamp() + '.csv');
  }

  function wireEvents() {
    els.startBtn.addEventListener('click', function () {
      if (els.startBtn.disabled) return;
      start();
    });

    els.pauseBtn.addEventListener('click', function () {
      const label = els.pauseBtn.textContent;
      if (label === 'Resume') runControl('resume');
      else runControl('pause');
    });

    els.stopBtn.addEventListener('click', function () {
      const confirmed = window.confirm('Stop the extraction? All collected data will be preserved.');
      if (confirmed) runControl('stop');
    });

    els.exportBtn.addEventListener('click', exportExcel);
    els.resetBtn.addEventListener('click', startNewJobClicked);

    els.areasInput.addEventListener('input', function () {
      const count = parseAreas().length;
      els.areaCount.textContent = count + ' area' + (count === 1 ? '' : 's') + ' entered';
    });
  }

  function init() {
    initDom();
    wireEvents();
    const count = parseAreas().length;
    els.areaCount.textContent = count + ' area' + (count === 1 ? '' : 's') + ' entered';

    chrome.runtime.onMessage.addListener(function (message) {
      if (message && message.type === 'GME_STATE' && message.state) {
        renderState(message.state);
      }
    });

    pollTimer = setInterval(refreshFromStorage, 800);
    refreshFromStorage();

    getActiveTab().then(function (tab) {
      if (!tab || !tab.id) return;
      if (!isMapsUrl(tab.url)) {
        showNotice('Make sure Google Maps is open in the active tab before starting.');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    init: init
  };
})();