const BG = (function () {
  function setBadge(text, color) {
    try {
      chrome.action.setBadgeBackgroundColor({ color: color || '#1a73e8' });
      chrome.action.setBadgeText({ text: text || '' });
    } catch (error) {}
  }

  function sendNotification(title, message) {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: title,
        message: message
      });
    } catch (error) {}
  }

  function handleStateMessage(message) {
    if (!message || !message.type) return;
    if (message.type === 'GME_FINISHED') {
      setBadge('done', '#188038');
      const state = message.state || {};
      sendNotification(
        'Extraction Completed',
        state.totalRecords + ' valid locations collected, ' + (state.temporarilyClosedSkipped || 0) +
        ' temporarily closed skipped - Areas: ' + state.areaIndex + '/' + state.totalAreas +
        ' - Duplicates removed: ' + state.duplicatesRemoved
      );
    } else if (message.type === 'GME_ERROR') {
      setBadge('error', '#d93025');
      sendNotification('Extraction Error', message.message || 'Something went wrong during extraction.');
    } else if (message.type === 'GME_STATE') {
      const state = message.state || {};
      if (state.status === 'running') setBadge('...', '#1a73e8');
      if (state.status === 'stopped') setBadge('off', '#5f6368');
      if (state.status === 'completed') setBadge('done', '#188038');
      if (state.status === 'paused') setBadge('||', '#f9ab00');
    }
  }

  chrome.runtime.onMessage.addListener(function (message) {
    handleStateMessage(message);
  });

  chrome.runtime.onInstalled.addListener(function () {
    setBadge('', '');
  });

  return {
    handleStateMessage: handleStateMessage,
    setBadge: setBadge
  };
})();