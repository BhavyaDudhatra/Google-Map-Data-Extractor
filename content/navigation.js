function buildSearchUrl(profession, area) {
  const query = cleanText(profession + ' in ' + area).replace(/\+/g, ' ');
  const encoded = encodeURIComponent(query)
    .replace(/%20/g, '+')
    .replace(/%2C/gi, ',');
  return 'https://www.google.com/maps/search/' + encoded;
}

function isGoogleMapsPage() {
  return /^(https:\/\/)?(maps\.google\.com|www\.google\.com\/maps)/i.test(location.href);
}

function currentSearchTextFromUrl() {
  try {
    const match = location.pathname.match(/\/maps\/search\/([^/]+)/);
    if (match) {
      const raw = match[1].split('@')[0];
      return decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
    }
  } catch (error) {
    return '';
  }
  return '';
}

function navigateTo(url) {
  location.assign(url);
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function waitFor(predicate, options) {
  const cfg = options || {};
  const timeout = cfg.timeout || 25000;
  const interval = cfg.interval || 350;
  const started = Date.now();
  return new Promise(function (resolve) {
    const probe = function () {
      let result = null;
      try {
        result = predicate();
      } catch (error) {
        result = null;
      }
      if (result) {
        resolve(result);
        return;
      }
      if (Date.now() - started >= timeout) {
        resolve(null);
        return;
      }
      setTimeout(probe, interval);
    };
    probe();
  });
}

function getFeedElement() {
  return document.querySelector(MapsDom.feed);
}

function getArticleElements(feed) {
  return feed ? Array.prototype.slice.call(feed.querySelectorAll(MapsDom.article)) : [];
}

function feedScrollable(feed) {
  if (!feed) return false;
  return feed.scrollHeight > feed.clientHeight + 40;
}

function scrollFeedBottom(feed) {
  if (!feed) return;
  feed.scrollTop = feed.scrollHeight;
}

function findNextPageButton() {
  for (const selector of MapsDom.nextPage) {
    const nodes = findIn(document, selector);
    for (const node of nodes) {
      const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
      if (!disabled && node.offsetParent !== null) return node;
    }
  }
  for (const selector of MapsDom.nextPage) {
    const nodes = findIn(document, selector);
    for (const node of nodes) {
      const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
      if (!disabled) return node;
    }
  }
  return null;
}

function waitForFeed(timeout) {
  return waitFor(function () {
    const feed = getFeedElement();
    if (!feed) return null;
    const articles = getArticleElements(feed);
    return articles.length > 0 ? { feed: feed, articles: articles } : null;
  }, { timeout: timeout || 30000, interval: 500 });
}

function waitForDetailPanel(timeout) {
  return waitFor(function () {
    const heading = findIn(document, MapsDom.detailName);
    return heading.length > 0 ? heading[0] : null;
  }, { timeout: timeout || 18000, interval: 300 });
}

function clickElement(node) {
  if (!node) return false;
  try {
    node.scrollIntoView({ block: 'center' });
  } catch (error) {}
  try {
    node.click();
    return true;
  } catch (error) {
    return false;
  }
}

function openInfoTabIfPresent() {
  const tabs = findIn(document, MapsDom.infoTabs);
  for (const tab of tabs) {
    const text = cleanText(tab.innerText || tab.getAttribute('aria-label') || '').toLowerCase();
    if (text === MapsText.infoTabName && tab.offsetParent !== null) {
      clickElement(tab);
      return true;
    }
  }
  return false;
}

function clickMoreActionIfPresent() {
  for (const selector of MapsDom.moreActionButton) {
    const nodes = findIn(document, selector);
    for (const node of nodes) {
      if (node.offsetParent !== null) {
        clickElement(node);
        return true;
      }
    }
  }
  return false;
}

function refreshFeedView() {
  const feed = getFeedElement();
  if (feed) {
    scrollFeedBottom(feed);
    const checkpoint = feed.scrollHeight;
    return { feed: feed, checkpoint: checkpoint, count: getArticleElements(feed).length };
  }
  return { feed: null, checkpoint: 0, count: 0 };
}

function waitForNewArticles(beforeCount, timeout) {
  return waitFor(function () {
    const feed = getFeedElement();
    if (!feed) return null;
    const count = getArticleElements(feed).length;
    if (count > beforeCount) return true;
    return false;
  }, { timeout: timeout || 12000, interval: 400 });
}

function waitForFeedHeightGrow(beforeHeight, timeout) {
  return waitFor(function () {
    const feed = getFeedElement();
    if (!feed) return null;
    return feed.scrollHeight > beforeHeight ? true : null;
  }, { timeout: timeout || 12000, interval: 400 });
}

function currentArticleIdentities(feed) {
  const ids = new Set();
  if (!feed) return ids;
  const articles = getArticleElements(feed);
  for (const article of articles) {
    const id = articleIdentity(article);
    if (id) ids.add(id);
  }
  return ids;
}

function hasNewArticleIdentity(beforeSet) {
  const feed = getFeedElement();
  if (!feed) return false;
  const ids = currentArticleIdentities(feed);
  if (ids.size === 0) return false;
  for (const id of ids) {
    if (!beforeSet.has(id)) return true;
  }
  return false;
}

function waitForArticleSetChange(beforeSet, timeout) {
  return waitFor(function () {
    return hasNewArticleIdentity(beforeSet) ? true : null;
  }, { timeout: timeout || AppLen.nextPageWaitMs, interval: 400 });
}

function nextPageButtonState() {
  let fallback = null;
  for (const selector of MapsDom.nextPage) {
    const nodes = findIn(document, selector);
    for (const node of nodes) {
      const enabled = !(node.disabled || node.getAttribute('aria-disabled') === 'true');
      if (enabled) return { exists: true, enabled: true, node: node };
      if (!fallback) fallback = node;
    }
  }
  return fallback ? { exists: true, enabled: false, node: fallback } : { exists: false, enabled: false, node: null };
}

function waitForFeedSettled(timeout) {
  return waitFor(function () {
    const feed = getFeedElement();
    if (!feed) return null;
    const articles = getArticleElements(feed);
    if (!articles.length) return null;
    let ready = 0;
    for (const article of articles) {
      if (hasArticleContent(article)) ready++;
    }
    return ready >= articles.length - 1 ? true : null;
  }, { timeout: timeout || 8000, interval: 300 });
}