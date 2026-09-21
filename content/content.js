(function () {
  function respond(sendResponse, data) {
    try {
      sendResponse(data);
    } catch (error) {}
  }

  function sendResponseAsync(sendResponse, promise) {
    let settled = false;
    promise.then(function (result) {
      if (settled) return;
      settled = true;
      respond(sendResponse, result);
    });
    return true;
  }

  function handleStartMessage(message, sendResponse) {
    Runner.startJob({ areas: message.areas, profession: message.profession }).then(function (result) {
      respond(sendResponse, result);
    });
  }

  function consumePendingStart() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(JobKeys.pendingStart, function (result) {
        const pending = result && result[JobKeys.pendingStart];
        if (!pending) {
          resolve(false);
          return;
        }
        chrome.storage.local.remove(JobKeys.pendingStart, function () {
          const areas = Array.isArray(pending.areas) ? pending.areas : [];
          const profession = typeof pending.profession === 'string' ? pending.profession : '';
          Runner.startJob({ areas: areas, profession: profession }).then(function () {
            resolve(true);
          });
        });
      });
    });
  }

  function tryConsumePendingStartIfOnMaps() {
    if (!isGoogleMapsPage()) return;
    consumePendingStart();
  }

  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (!request || typeof request.type !== 'string') return false;
    switch (request.type) {
      case 'GME_START':
        handleStartMessage(request, sendResponse);
        return true;
      case 'GME_PAUSE':
        return sendResponseAsync(sendResponse, Promise.resolve(Runner.pauseJob()));
      case 'GME_RESUME':
        return sendResponseAsync(sendResponse, Promise.resolve(Runner.resumeJob()));
      case 'GME_STOP':
        return sendResponseAsync(sendResponse, Promise.resolve(Runner.stopJob()));
      case 'GME_RESET':
        return sendResponseAsync(sendResponse, Promise.resolve(Runner.resetJob()));
      case 'GME_GET_STATE':
        return sendResponseAsync(sendResponse, Promise.resolve({
          ok: true,
          isMaps: isGoogleMapsPage(),
          state: Runner.getStateSummary()
        }));
      case 'GME_PING':
        respond(sendResponse, {
          ok: true,
          isMaps: isGoogleMapsPage(),
          state: Runner.getStateSummary()
        });
        return false;
      default:
        return false;
    }
  });

  function onReady() {
    tryConsumePendingStartIfOnMaps();
    Runner.onPageReady();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();