const ScrapeAlgorithm = (function () {

  const AppLen = {
    maxAreas: 1000,
    minAreas: 1,
    batchSize: 100,
    flushEvery: 25,
    scrollMaxRounds: 400,
    emptyScrollRetries: 3,
    articleRetryCount: 2,
    pageNoChangeLimit: 2,
    lazyLoadWaitMs: 5000,
    nextPageWaitMs: 12000
  };

  const MapsDom = {
    feed: 'div[role="feed"]',
    article: 'div[role="article"]',
    articleLink: 'div[role="article"] a[href*="/maps/place/"], div[role="article"] a[href*="maps/place"], div[role="article"] a[data-fid][href]',

    detailName: ['h1[aria-label]', 'h1', '.DUwDvf', '[data-attrid="title"]'],

    detailAddress: [
      '[data-item-id="address"]',
      '[data-item-id*="address"]',
      'a[data-item-id*="address"]',
      'button[data-item-id*="address"]'
    ],

    detailPhone: [
      '[href^="tel:"]',
      '[data-item-id*="phone"]',
      'button[data-item-id*="phone"]',
      'a[data-tooltip*="phone" i]'
    ],

    detailWebsite: [
      '[data-item-id*="website"]',
      'a[data-item-id*="website"]'
    ],

    detailRating: [
      '[aria-label*="stars"]',
      '[aria-label*=" rated "]'
    ],

    detailHours: [
      '[data-item-id^="oh-"]',
      '[data-item-id*="hours"]'
    ],

    detailPlusCode: [
      '[data-item-id*="plus-code"]',
      'button[data-item-id*="plus-code"]'
    ],

    headingText: ['h1', 'h2', 'h3', 'span[role="heading"]'],
    panelRoot: 'div[role="main"]',

    nextPage: [
      'button[aria-label="Next page"]',
      'button[aria-label="Next"]',
      'button[aria-label*="More results"]',
      'button[aria-label*="Show more"]',
      '[role="button"][aria-label*="Next" i]'
    ],

    infoTabs: '[role="tab"], [role="button"], button',
    moreActionButton: ['button[aria-label="More"]', '[role="button"][aria-label="More"]'],

    noResultsMarkers: [
      'No results',
      'not found. Try',
      'Could not find',
      'No matches'
    ],

    blockedMarkers: [
      'Before you continue to Google',
      'Enable JavaScript and cookies',
      'Why did this page load with a prompt',
      'Unusual traffic'
    ],

    searchInput: [
      'input#searchboxinput',
      'input[aria-label="Search Google Maps"]',
      'input.searchboxinput'
    ],

    temporarilyClosed: ['temporarily closed']
  };

  const MapsText = {
    infoTabName: 'info',
    phoneHeading: 'phone',
    addressHeading: 'address',
    addressLabel: 'copy address',
    noLocations: 'no locations'
  };

  const MapsExp = {
    resultCountHeader: /([\d,.]+)\s*(places|results)/i,
    queryHeading: /Places for\s+(.+)/i,
    areaSuffix: /\bin\s+[^.]+$/i,
    phoneLocal: /(\+?\d{1,3}[\s.-]?)?(\(?\d{2,5}\)?[\s.-]?)?\d[\d\s().-]{5,14}\d/,
    addressHint: /\b(road|rd|street|st|lane|ln|avenue|ave|society|colony|nagar|soho|floor|lvl|flyover|bridge|hwy|highway|cross|chowk|market|complex|tower|mall|plaza|zone|sector|phase|estate|industrial area|plot|survey|campus|university|college|school|hospital|opp|opposite|near|beside|block|wing|unit|shop|office|tower)\b/i
  };

  const JobKeys = {
    job: 'gme_job',
    meta: 'gme_rec_meta',
    pendingStart: 'gme_pending_start'
  };

  function batchKey(jobId, index) {
    return 'gme_rec_batch_' + jobId + '_' + index;
  }

  const Adapter = {
    storageGet: null,
    storageGetAll: null,
    storageSet: null,
    storageRemove: null,
    sendMessage: null,
    navigate: null,
    locationHref: null,
    pathname: null
  };

  function create(context) {
    Adapter.storageGet = context.storageGet || function () { return Promise.resolve({}); };
    Adapter.storageGetAll = context.storageGetAll || function () { return Promise.resolve({}); };
    Adapter.storageSet = context.storageSet || function () { return Promise.resolve(); };
    Adapter.storageRemove = context.storageRemove || function () { return Promise.resolve(); };
    Adapter.sendMessage = context.sendMessage || function () {};
    Adapter.navigate = context.navigate || function () { throw new Error('Adapter.navigate not provided'); };
    Adapter.locationHref = context.locationHref || function () { return globalThis.location && globalThis.location.href; };
    Adapter.pathname = context.pathname || function () { return globalThis.location && globalThis.location.pathname; };

    const runner = createRunner();
    return {
      runner: runner,
      functions: {
        buildSearchUrl: buildSearchUrl,
        cleanText: cleanText,
        normPhone: normPhone,
        dedupeKey: dedupeKey,
        isProbablyPhone: isProbablyPhone,
        addressScore: addressScore,
        articleIdentity: articleIdentity,
        containsTemporarilyClosed: containsTemporarilyClosed,
        isNoResultsPage: isNoResultsPage,
        isBlockedPage: isBlockedPage,
        waitFor: waitFor,
        waitForFeed: waitForFeed,
        nextPageButtonState: nextPageButtonState,
        extractFromDetailPanel: extractFromDetailPanel,
        extractFromFeedItem: extractFromFeedItem
      }
    };
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r\n]+/g, ' ')
      .trim();
  }

  function cleanPhoneDigits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function normPhone(value) {
    const digits = cleanPhoneDigits(value);
    if (!digits) return '';
    if (digits.length === 10) return digits;
    if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
    if (digits.length > 10) return digits;
    return digits;
  }

  function lowerPlain(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9+]/gi, '');
  }

  function dedupeKey(record) {
    const name = lowerPlain((record.name || '').replace(/\s*\(call\)\s*$/i, ''));
    const address = lowerPlain(record.address || '');
    const phone = normPhone(record.phone || '');
    const base = [name, address].join('|');
    return (base || phone || '') ? base + (phone ? '|' + phone : '') : '';
  }

  function digitGroups(text) {
    return String(text || '').split(/\D+/).filter(Boolean);
  }

  function findIn(root, selector) {
    const results = [];
    const sources = Array.isArray(selector) ? selector : [selector];
    for (const source of sources) {
      try {
        const nodes = root.querySelectorAll(source);
        for (let i = 0; i < nodes.length; i++) results.push(nodes[i]);
      } catch (error) {
        continue;
      }
    }
    const seen = new Set();
    const unique = [];
    for (const node of results) {
      if (!seen.has(node)) {
        seen.add(node);
        unique.push(node);
      }
    }
    return unique;
  }

  function buildSearchUrl(profession, area) {
    const query = cleanText(profession + ' in ' + area).replace(/\+/g, ' ');
    const encoded = encodeURIComponent(query)
      .replace(/%20/g, '+')
      .replace(/%2C/gi, ',');
    return 'https://www.google.com/maps/search/' + encoded;
  }

  function isGoogleMapsPage() {
    return /^(https:\/\/)?(maps\.google\.com|www\.google\.com\/maps)/i.test(Adapter.locationHref());
  }

  function currentSearchTextFromUrl() {
    try {
      const match = Adapter.pathname().match(/\/maps\/search\/([^/]+)/);
      if (match) {
        const raw = match[1].split('@')[0];
        return decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
      }
    } catch (error) {
      return '';
    }
    return '';
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

  function getFeedElement(doc) {
    return doc.querySelector(MapsDom.feed);
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

  function findNextPageButton(doc) {
    for (const selector of MapsDom.nextPage) {
      const nodes = findIn(doc, selector);
      for (const node of nodes) {
        const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
        if (!disabled && node.offsetParent !== null) return node;
      }
    }
    for (const selector of MapsDom.nextPage) {
      const nodes = findIn(doc, selector);
      for (const node of nodes) {
        const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
        if (!disabled) return node;
      }
    }
    return null;
  }

  function waitForFeed(timeout, doc) {
    return waitFor(function () {
      const feed = getFeedElement(doc);
      if (!feed) return null;
      const articles = getArticleElements(feed);
      return articles.length > 0 ? { feed: feed, articles: articles } : null;
    }, { timeout: timeout || 30000, interval: 500 });
  }

  function waitForDetailPanel(timeout, doc) {
    return waitFor(function () {
      const heading = findIn(doc, MapsDom.detailName);
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

  function openInfoTabIfPresent(doc) {
    const tabs = findIn(doc, MapsDom.infoTabs);
    for (const tab of tabs) {
      const text = cleanText(tab.innerText || tab.getAttribute('aria-label') || '').toLowerCase();
      if (text === MapsText.infoTabName && tab.offsetParent !== null) {
        clickElement(tab);
        return true;
      }
    }
    return false;
  }

  function clickMoreActionIfPresent(doc) {
    for (const selector of MapsDom.moreActionButton) {
      const nodes = findIn(doc, selector);
      for (const node of nodes) {
        if (node.offsetParent !== null) {
          clickElement(node);
          return true;
        }
      }
    }
    return false;
  }

  function waitForNewArticles(beforeCount, timeout, doc) {
    return waitFor(function () {
      const feed = getFeedElement(doc);
      if (!feed) return null;
      const count = getArticleElements(feed).length;
      if (count > beforeCount) return true;
      return false;
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

  function hasNewArticleIdentity(beforeSet, doc) {
    const feed = getFeedElement(doc);
    if (!feed) return false;
    const ids = currentArticleIdentities(feed);
    if (ids.size === 0) return false;
    for (const id of ids) {
      if (!beforeSet.has(id)) return true;
    }
    return false;
  }

  function waitForArticleSetChange(beforeSet, timeout, doc) {
    return waitFor(function () {
      return hasNewArticleIdentity(beforeSet, doc) ? true : null;
    }, { timeout: timeout || AppLen.nextPageWaitMs, interval: 400 });
  }

  function nextPageButtonState(doc) {
    let fallback = null;
    for (const selector of MapsDom.nextPage) {
      const nodes = findIn(doc, selector);
      for (const node of nodes) {
        const enabled = !(node.disabled || node.getAttribute('aria-disabled') === 'true');
        if (enabled) return { exists: true, enabled: true, node: node };
        if (!fallback) fallback = node;
      }
    }
    return fallback ? { exists: true, enabled: false, node: fallback } : { exists: false, enabled: false, node: null };
  }

  function waitForFeedSettled(timeout, doc) {
    return waitFor(function () {
      const feed = getFeedElement(doc);
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

  function isProbablyPhone(text) {
    const t = cleanText(text || '');
    if (!t || !/\d/.test(t)) return false;
    const lower = t.toLowerCase();
    const hasAddressWords = /(road|rd\.?|street|st\.?|lane|ln\.?|nagar|society|colony|complex|tower|mall|plaza|building|cross|crossing|chowk|market|sector|phase|block|shop|office|unit|floor|lvl|highway|hwy|opp|opposite|near|beside|layout|ext|extension|main|bungalows?|plot|area|district|estate|drive|way)\b/i.test(lower);
    if (hasAddressWords) return false;
    const digits = cleanPhoneDigits(t);
    if (digits.length < 7 || digits.length > 15) return false;
    const runs = digitGroups(t);
    let maxRun = 0;
    for (const r of runs) {
      if (r.length > maxRun) maxRun = r.length;
    }
    if (runs.length > 4) return false;
    if (runs.length > 1 && maxRun < 3) return false;
    if (/[a-z]/i.test(lower) && digits.length < 9) return false;
    if (lower.indexOf('tel:') !== -1) return false;
    return true;
  }

  function searchPhoneInText(text) {
    const source = String(text || '');
    const lines = source.split('\n').map(function (l) { return cleanText(l); }).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isProbablyPhone(line)) return line;
    }
    const match = source.match(MapsExp.phoneLocal);
    if (match && isProbablyPhone(match[0])) return cleanText(match[0]);
    return '';
  }

  function addressScore(line) {
    const t = cleanText(line);
    if (!t) return -100;
    const lower = t.toLowerCase();
    const words = t.split(/\s+/).length;
    const hasDigits = /\d/.test(t);
    const hasComma = /,/.test(t);
    const hasAreaSuffix = /(nagar|ahmedabad|gandhinagar|surendranagar|surat|vadodara|rajkot|junagadh|bhavnagar|jamnagar|amreli|porbandar|bhuj|mandvi|anjar|kalol|mehsana|nadiad|anand|vidhyanagar|petlad|godhra|palanpur|itarsi|gujarat|mumbai|delhi|bengaluru|bangalore|pune|kolkata|chennai|hyderabad|jaipur|goa|city|district|state|metro|highway)/i.test(lower);
    const hint = MapsExp.addressHint.test(lower);
    const isTime = /(am\b|pm\b|open\b|opened\b|closed\b|opens\b|closes\b|hours\b|hour\b|minutes\b|min\b|noon|midnight|today|tomorrow|yesterday)/i.test(t);
    const isRating = /(^\s*\d([.,]\d)?\s*(\([\d,]+\))?\s*$)|(\breviews?\b|\bratings?\b|\bstars?\b|\bvoted?\b)/i.test(t);
    let score = 0;
    if (hasDigits) score += 2;
    if (hasComma) score += 2;
    if (hint) score += 3;
    if (hasAreaSuffix) score += 2;
    if (words >= 3) score += 1;
    if (isTime) score -= 6;
    if (isRating) score -= 4;
    if (isProbablyPhone(t)) return -50;
    if (words === 1) score -= 2;
    if (!hasDigits && !hasComma && !hasAreaSuffix) score -= 2;
    return score;
  }

  function extractPhoneFromElement(root) {
    for (const selector of MapsDom.detailPhone) {
      const nodes = findIn(root, selector);
      for (const node of nodes) {
        const href = node.getAttribute ? node.getAttribute('href') : '';
        if (typeof href === 'string' && /^tel:/i.test(href)) {
          const digits = cleanPhoneDigits(href.slice(4));
          if (digits.length >= 7 && digits.length <= 15) {
            const canonical = normPhone(digits);
            if (canonical) {
              const text = cleanText(node.innerText || '');
              if (text && isProbablyPhone(text) && normPhone(text) === canonical) return text;
              return canonical;
            }
          }
        }
      }
    }
    for (const selector of MapsDom.detailPhone) {
      const nodes = findIn(root, selector);
      for (const node of nodes) {
        const text = cleanText(node.innerText || node.getAttribute('aria-label') || '');
        if (text && isProbablyPhone(text)) return text;
      }
    }
    return '';
  }

  function cleanAddressLabel(text) {
    let cleaned = cleanText(text);
    cleaned = cleaned.replace(/^(address|full address|area)\s*[:.\u2013-]?\s*/i, '').trim();
    if (/^copy address\s*$/i.test(cleaned)) return '';
    return cleaned;
  }

  function extractAddressFromElement(root) {
    for (const selector of MapsDom.detailAddress) {
      const nodes = findIn(root, selector);
      for (const node of nodes) {
        const raw = cleanText(node.innerText || node.getAttribute('aria-label') || '');
        const text = cleanAddressLabel(raw);
        if (text && text.length > 4 && addressScore(text) >= 2) return text;
      }
    }
    const headings = findIn(root, MapsDom.headingText);
    for (const heading of headings) {
      const h = cleanText(heading.innerText || '');
      if (MapsText.addressHeading === h.toLowerCase() || MapsText.addressLabel === h.toLowerCase()) {
        const sibling = heading.parentElement ? heading.parentElement.nextElementSibling : null;
        if (sibling) {
          const text = cleanAddressLabel(sibling.innerText || '');
          if (text && addressScore(text) >= 1) return text;
        }
      }
    }
    return '';
  }

  function isValidNameText(text) {
    if (!text) return false;
    if (containsTemporarilyClosed(text)) return false;
    if (text.length < 2) return false;
    if (/^[.,\u00b7|:;\-]+$/.test(text)) return false;
    if (isProbablyPhone(text)) return false;
    const lower = text.toLowerCase();
    if (/^(address|menu|directions|overview|reviews?|photos?|about|share|save start|clone|call now|not there|closed)\b/.test(lower)) return false;
    if (/\b\d\s*\.?\s*\d?\s*stars?\b/i.test(lower)) return false;
    return true;
  }

  function findDetailNameNode(doc) {
    const seenNodes = new Set();
    for (const selector of MapsDom.detailName) {
      for (const node of findIn(doc, selector)) {
        if (seenNodes.has(node)) continue;
        seenNodes.add(node);
        const text = cleanText(node.getAttribute('aria-label') || node.innerText || '');
        if (isValidNameText(text)) return node;
      }
    }
    return null;
  }

  function extractNameElement(root) {
    const node = findDetailNameNode(root);
    if (node) return cleanText(node.getAttribute('aria-label') || node.innerText || '');
    return '';
  }

  function extractFeedLink(article) {
    const nodes = findIn(article, MapsDom.articleLink);
    for (const node of nodes) {
      const href = node.getAttribute('href');
      if (href && href.indexOf('/maps/place/') !== -1) return node;
      if (href && href.indexOf('maps/place') !== -1) return node;
    }
    return null;
  }

  function extractFeedName(article) {
    const link = extractFeedLink(article);
    if (link) {
      const aria = cleanText(link.getAttribute('aria-label'));
      if (aria) {
        const cleaned = aria.replace(/^label\s*[:.]?\s*/i, '');
        if (cleaned) return cleaned;
      }
      const heading = link.querySelector('h3, [role="heading"]');
      if (heading) {
        const t = cleanText(heading.innerText);
        if (t) return t;
      }
      const inner = cleanText(link.innerText || '');
      if (inner) return inner.split('\n')[0].trim();
    }
    const heading = article.querySelector('h3, [role="heading"], .qBF1Pd');
    if (heading) {
      const t = cleanText(heading.innerText);
      if (t) return t;
    }
    const inner = cleanText(article.innerText || '');
    if (inner) return inner.split('\n')[0].replace(/^label\s*[:.]?\s*/i, '').trim();
    return '';
  }

  function extractFeedSnapshot(article) {
    const text = cleanText(article.innerText || '');
    const lines = text.split(/[|\n·]/).map(function (l) { return cleanText(l); }).filter(Boolean);
    return lines;
  }

  function extractFromFeedItem(article) {
    const link = extractFeedLink(article);
    const url = link ? link.getAttribute('href') : '';
    const name = extractFeedName(article);
    const nameKey = lowerPlain(name);
    const snapshot = extractFeedSnapshot(article);
    let address = '';
    for (const line of snapshot) {
      if (nameKey && lowerPlain(line) === nameKey) continue;
      if (isProbablyPhone(line)) continue;
      if (addressScore(line) >= 4) {
        address = line;
        break;
      }
    }
    return { name: name, url: url, address: address, phone: '' };
  }

  function articleIdentity(article) {
    const link = extractFeedLink(article);
    if (link) {
      const href = link.getAttribute('href');
      if (href && href.indexOf('place/') !== -1) return href;
    }
    const fid = article.getAttribute('data-fid');
    if (fid) return 'fid:' + fid;
    const name = extractFeedName(article);
    if (name) return 'name:' + lowerPlain(name);
    return 'el:' + article.getBoundingClientRect().top.toFixed(0);
  }

  function extractFromDetailPanel(root) {
    const name = extractNameElement(root);
    const phone = extractPhoneFromElement(root);
    let address = extractAddressFromElement(root);
    if (!address) {
      const lines = cleanText(root.innerText || '').split('\n').map(function (l) { return cleanText(l); }).filter(Boolean);
      const nameKey = lowerPlain(name);
      let best = '';
      let bestScore = -1;
      for (const line of lines) {
        if (nameKey && lowerPlain(line) === nameKey) continue;
        if (isProbablyPhone(line)) continue;
        const score = addressScore(line);
        if (score > bestScore) {
          bestScore = score;
          best = line;
        }
      }
      if (bestScore >= 4) address = best;
    }
    const categoryInfo = extractCategoryAndPrice(root);
    return {
      name: name,
      address: address,
      phone: phone,
      website: extractWebsite(root),
      rating: extractRating(root),
      reviews: extractReviewsCount(root),
      hours: extractHours(root),
      plusCode: extractPlusCode(root),
      category: categoryInfo.category,
      priceLevel: categoryInfo.priceLevel
    };
  }

  function findInfoContainer(root) {
    const nameNode = findDetailNameNode(root);
    if (!nameNode) return null;
    let el = nameNode;
    let best = nameNode;
    for (let step = 0; step < 7 && el && el !== root.body; step++) {
      if (el.querySelector(MapsDom.feed)) break;
      best = el;
      el = el.parentElement;
    }
    return best;
  }

  function panelTextLines(root) {
    const container = findInfoContainer(root);
    const source = container || root.body;
    const text = cleanText(source.innerText || '');
    return text.split('\n').map(function (l) { return cleanText(l); }).filter(Boolean);
  }

  function dedupeLines(lines) {
    const seen = new Set();
    const out = [];
    for (const line of lines) {
      const key = lowerPlain(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
  }

  function extractFullPanelText(root) {
    return dedupeLines(panelTextLines(root)).join('\n');
  }

  function extractWebsite(root) {
    for (const node of findIn(root, MapsDom.detailWebsite)) {
      const href = node.getAttribute('href') || '';
      const text = cleanText(node.innerText || '');
      if (/^https?:\/\//i.test(text)) return text;
      if (/^https?:\/\//i.test(href)) return href;
    }
    const links = root.querySelectorAll('a[href]');
    for (const node of links) {
      const href = String(node.getAttribute('href') || '').trim();
      if (!href) continue;
      const lower = href.toLowerCase();
      if (!/^https?:\/\//i.test(lower)) continue;
      if (/google\.com|g\.co|maps\.google/i.test(lower)) continue;
      const text = cleanText(node.innerText || '');
      if (text && /^https?:\/\//i.test(text)) return text;
      return href;
    }
    return '';
  }

  function extractRating(root) {
    for (const node of findIn(root, MapsDom.detailRating)) {
      const label = cleanText(node.getAttribute('aria-label') || node.innerText || '');
      const m = label.match(/(?:rated\s+)?(\d(?:[.,]\d)?)\s*(?:out of 5|stars?)/i);
      if (m) return m[1];
      const s = label.match(/(\d(?:[.,]\d)?)\s*[★]/);
      if (s) return s[1];
    }
    const text = cleanText(root.innerText || '');
    const m = text.match(/(\d(?:[.,]\d)?)\s*[★]/);
    if (m) return m[1];
    return '';
  }

  function extractReviewsCount(root) {
    const nodes = findIn(root, '[aria-label*="reviews" i], [aria-label*="review" i]');
    for (const node of nodes) {
      const label = cleanText(node.getAttribute('aria-label') || '');
      const m = label.match(/([\d,]+)\s*reviews?/i);
      if (m) return m[1].replace(/,/g, '');
    }
    const text = cleanText(root.innerText || '');
    const m = text.match(/\(([\d,]+)\)\s*reviews?/i) || text.match(/([\d.,]+)\s*reviews?/i);
    if (m) return String(m[1]).replace(/,/g, '');
    return '';
  }

  function extractHours(root) {
    const nodes = findIn(root, MapsDom.detailHours);
    for (const node of nodes) {
      const text = cleanText(node.innerText || node.getAttribute('aria-label') || '');
      if (text && /(open|closed|hours|closes|opens|24 hours)/i.test(text)) return text;
    }
    const lines = panelTextLines(root);
    for (const line of lines) {
      if (/^(open|closes?|opens?|closed)\b/i.test(line)) return line;
      if (/\b24 hours\b/i.test(line)) return line;
    }
    return '';
  }

  function extractPlusCode(root) {
    const nodes = findIn(root, MapsDom.detailPlusCode);
    for (const node of nodes) {
      const text = cleanText(node.innerText || node.getAttribute('aria-label') || '');
      const m = text.match(/([0-9A-Z]{7,8}\+[0-9A-Z]{2,3})/);
      if (m) return m[1];
    }
    const text = cleanText(root.innerText || '');
    const m = text.match(/([0-9A-Z]{7,8}\+[0-9A-Z]{2,3})/);
    if (m) return m[1];
    return '';
  }

  function extractCategoryAndPrice(root) {
    const lines = panelTextLines(root);
    const nameKey = lowerPlain(extractNameElement(root));
    let category = '';
    let price = '';
    for (const line of lines) {
      if (nameKey && lowerPlain(line) === nameKey) continue;
      const lower = line.toLowerCase();
      const priceMatch = line.match(/^(?:₹{1,5}|\${1,5})/);
      if (priceMatch) {
        price = priceMatch[0];
        continue;
      }
      if (isProbablyPhone(line)) continue;
      if (containsTemporarilyClosed(line)) continue;
      if (/^\d(?:[.,]\d)?\s*[★]/.test(line)) continue;
      if (/reviews?|ratings?|stars?\b/i.test(line)) continue;
      if (/(open|closes?|opens?|closed|hours)\b/i.test(lower)) continue;
      if (line.length > 40) continue;
      if (/^(directions|call|share|save|more|menu)\b/i.test(lower)) continue;
      category = line;
      break;
    }
    return { category: category, priceLevel: price };
  }

  function containsTemporarilyClosed(text) {
    if (!text) return false;
    const lower = cleanText(text).toLowerCase();
    for (const marker of MapsDom.temporarilyClosed) {
      if (lower.indexOf(marker) !== -1) return true;
    }
    return false;
  }

  function elementHasTemporarilyClosed(el) {
    if (!el) return false;
    return containsTemporarilyClosed(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
  }

  function hasArticleContent(article) {
    if (!article) return false;
    const link = extractFeedLink(article);
    if (link) return true;
    return Boolean(extractFeedName(article));
  }

  function hasAnyDetailField(root) {
    const ctx = root || globalThis.document;
    if (extractPhoneFromElement(ctx)) return true;
    if (extractAddressFromElement(ctx)) return true;
    if (extractWebsite(ctx)) return true;
    return false;
  }

  function pageBodyText(doc) {
    return cleanText(doc.body.innerText || '');
  }

  function isNoResultsPage(doc) {
    const text = pageBodyText(doc);
    for (const marker of MapsDom.noResultsMarkers) {
      if (text.indexOf(marker) !== -1) return true;
    }
    if (text.indexOf(MapsText.noLocations) !== -1) return true;
    return false;
  }

  function isBlockedPage(doc) {
    const text = pageBodyText(doc);
    for (const marker of MapsDom.blockedMarkers) {
      if (text.indexOf(marker) !== -1) return true;
    }
    return false;
  }

  function readResultCountFromPage(doc) {
    const text = pageBodyText(doc);
    const match = text.match(MapsExp.resultCountHeader);
    if (match) return Number(String(match[1]).replace(/[^\d]/g, ''));
    return 0;
  }

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

  function parseAreas(payload) {
    const seen = new Set();
    const areas = [];
    for (const raw of payload.areas || []) {
      const area = cleanText(raw);
      if (!area) continue;
      const low = area.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      areas.push(area);
    }
    return areas;
  }

  function createRunner() {
    let job = null;
    let seenSet = new Set();
    let pendingBatch = [];
    let persistTimer = null;
    let areaRunInProgress = false;
    let broadcastTimer = null;
    let lastBatchIndex = -1;
    let areaProcessed = new Set();
    let flushQueue = Promise.resolve();

    function persistNow() {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (!job) return;
      job.updatedAt = nowIso();
      const snapshot = JSON.parse(JSON.stringify(job));
      Adapter.storageSet({ [JobKeys.job]: snapshot });
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
        Adapter.sendMessage(payload);
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
      return Adapter.storageGet(JobKeys.job).then(function (result) {
        const stored = result && result[JobKeys.job];
        if (stored && stored.version === 1) {
          job = Object.assign(emptyJob(), stored);
          job.areas = Array.isArray(stored.areas) ? stored.areas : [];
        } else if (stored && stored.version !== 1) {
          job = Object.assign(emptyJob(), stored);
        } else {
          job = emptyJob();
        }
        return job;
      });
    }

    function getAllRecordKeys() {
      return Adapter.storageGetAll().then(function (all) {
        if (!all) return [];
        const prefix = job && job.jobId ? 'gme_rec_batch_' + job.jobId + '_' : 'gme_rec_batch_';
        const keys = Object.keys(all).filter(function (k) { return k.indexOf(prefix) === 0; });
        keys.sort(function (a, b) {
          const na = Number(a.split('_').pop());
          const nb = Number(b.split('_').pop());
          return na - nb;
        });
        return keys;
      });
    }

    function loadJobRecords() {
      return getAllRecordKeys().then(function (keys) {
        if (!keys.length) return [];
        return Adapter.storageGet(keys).then(function (result) {
          const records = [];
          for (const key of keys) {
            const batch = result[key];
            if (Array.isArray(batch)) records.push.apply(records, batch);
          }
          return records;
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
      if (!pendingBatch.length) return Promise.resolve();
      const jobId = job ? job.jobId : 'standalone';
      const batch = pendingBatch.slice();
      pendingBatch = [];
      return Adapter.storageGet(JobKeys.meta).then(function (result) {
        const meta = result && result[JobKeys.meta] ? result[JobKeys.meta] : { jobId: jobId, batchCount: 0, total: 0 };
        if (!meta.jobId) meta.jobId = jobId;
        const index = meta.batchCount;
        meta.batchCount += 1;
        meta.total += batch.length;
        lastBatchIndex = index;
        const toStore = {};
        toStore[batchKey(jobId, index)] = batch;
        toStore[JobKeys.meta] = meta;
        return Adapter.storageSet(toStore);
      });
    }

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
      Adapter.navigate(buildSearchUrl(job.profession, job.currentArea));
      return Promise.resolve(false);
    }

    function dismissPromptsAndDialogs(doc) {
      const dialog = doc.querySelector('[role="dialog"][aria-modal="true"]');
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

    function runArea(doc) {
      if (areaRunInProgress) return;
      if (!job || job.status !== 'running') return;
      areaRunInProgress = true;
      Promise.resolve()
        .then(ensureAreaSearchPage)
        .then(function (onRightPage) {
          if (!onRightPage) return null;
          if (job.status !== 'running') return null;
          dismissPromptsAndDialogs(doc);
          return extractCurrentArea(doc);
        })
        .catch(function (error) {
          handleAreaError(error);
        })
        .then(function () {
          areaRunInProgress = false;
        });
    }

    async function extractCurrentArea(doc) {
      job.areaCollected = 0;
      job.resultsFound = 0;
      job.scrollRound = 1;
      job.pageProcessed = 0;
      job.pageTotal = 0;
      job.currentSearch = expectedSearchText();
      areaProcessed = new Set();
      setStatusDetail('Loading results for ' + job.currentArea + '...');
      persistNow();

      const feedResult = await waitForFeed(35000, doc);
      if (!feedResult || !feedResult.feed) {
        if (isBlockedPage(doc)) {
          setErrorState('Google is blocking the page (captcha, consent or unusual traffic). Open Google Maps manually and try again.');
          return;
        }
        if (isGoogleMapsPage() && isNoResultsPage(doc)) {
          await finishArea();
          return;
        }
        setErrorState('Search results did not load in time for: ' + job.currentArea);
        return;
      }

      dismissPromptsAndDialogs(doc);
      const headingCount = readResultCountFromPage(doc);
      if (headingCount) job.resultsFound = headingCount;
      setStatusDetail('Processing page 1 of results for ' + job.currentArea + '...');
      persistNow();

      let loopSafety = 0;
      while (job.status === 'running') {
        const currentFeed = getFeedElement(doc);
        if (!currentFeed) {
          setErrorState('The results list disappeared while extracting: ' + job.currentArea);
          return;
        }
        await extractArticlesBatch(currentFeed, doc);
        if (job.status !== 'running') break;
        persistNow();

        const result = await advanceToNextResultSet(doc);
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

    async function extractArticlesBatch(feed, doc) {
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
        await extractArticle(article, doc);
        job.pageProcessed += 1;
        if (job.status === 'running') {
          setStatusDetail('Processing page ' + job.scrollRound + ' \u2014 ' + job.pageProcessed + ' / ' + job.pageTotal + ' for ' + job.currentArea + '...');
        }
        persistSoon(200);
      }
      return fresh.length > 0;
    }

    async function extractArticle(article, doc) {
      if (elementHasTemporarilyClosed(article)) {
        job.temporarilyClosedSkipped = (job.temporarilyClosedSkipped || 0) + 1;
        persistSoon(300);
        return;
      }

      const base = extractFromFeedItem(article);
      const link = extractFeedLink(article);
      const previousName = extractNameFromPage(doc);

      let clicked = false;
      for (let attempt = 0; attempt < AppLen.articleRetryCount; attempt++) {
        if (job.status !== 'running') break;
        if (link) clicked = clickElement(link);
        else if (article) clicked = clickElement(article);
        if (!clicked) break;
        const settled = await waitForPanelChange(previousName, 9000, doc);
        if (settled) {
          clicked = true;
          break;
        }
        clicked = false;
      }

      let detail = null;
      if (clicked && job.status === 'running') {
        const probe = await waitForDetailPanel(14000, doc);
        if (probe) await settlePanelInfo(doc);
        detail = extractFromDetailPanel(doc);
      }

      let fullData = '';
      if (detail && clicked && job.status === 'running') {
        fullData = extractFullPanelText(doc);
      }

      if (currentPanelHasTemporarilyClosed(doc)) {
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

    function extractNameFromPage(doc) {
      const nodes = findIn(doc, MapsDom.detailName);
      for (const node of nodes) {
        const text = cleanText(node.getAttribute('aria-label') || node.innerText || '');
        if (text) return text;
      }
      return '';
    }

    function waitForPanelChange(previousName, timeout, doc) {
      return waitFor(function () {
        const heading = findIn(doc, MapsDom.detailName);
        for (const node of heading) {
          const text = cleanText(node.getAttribute('aria-label') || node.innerText || '');
          if (text && (!previousName || text !== previousName)) return true;
        }
        const direct = doc.querySelector('h1');
        if (direct) {
          const text = cleanText(direct.innerText || '');
          if (text && (!previousName || text !== previousName)) return true;
        }
        return null;
      }, { timeout: timeout || 12000, interval: 300 });
    }

    function waitForDetailFields(timeout, doc) {
      return waitFor(function () {
        if (hasAnyDetailField(doc)) return true;
        return null;
      }, { timeout: timeout || 4500, interval: 350 });
    }

    function currentPanelHasTemporarilyClosed(doc) {
      const heading = findIn(doc, MapsDom.detailName);
      if (heading.length) {
        const ctx = heading[0].parentElement;
        if (ctx && containsTemporarilyClosed(ctx.innerText || '')) return true;
      }
      const main = doc.querySelector(MapsDom.panelRoot);
      if (main && containsTemporarilyClosed(main.innerText || '')) return true;
      return containsTemporarilyClosed(doc.body.innerText || '');
    }

    async function settlePanelInfo(doc) {
      if (await waitForDetailFields(4000, doc)) return;
      openInfoTabIfPresent(doc);
      if (await waitForDetailFields(3500, doc)) return;
      clickMoreActionIfPresent(doc);
      if (await waitForDetailFields(3000, doc)) return;
      openInfoTabIfPresent(doc);
      await waitForDetailFields(2500, doc);
    }

    async function advanceToNextResultSet(doc) {
      const feed = getFeedElement(doc);
      if (!feed) return false;
      const beforeSet = currentArticleIdentities(feed);

      scrollFeedBottom(feed);
      const quickExtra = await waitForArticleSetChange(beforeSet, 1500, doc);
      if (quickExtra) {
        await waitForFeedSettled(6000, doc);
        scrollFeedBottom(feed);
        return { more: true, advanced: false };
      }

      const initialNext = nextPageButtonState(doc);
      if (initialNext.exists && initialNext.enabled) {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (job.status !== 'running') return false;
          const state = nextPageButtonState(doc);
          if (!state.exists || !state.enabled) break;
          const clicked = clickElement(state.node);
          if (!clicked) continue;
          const changed = await waitForArticleSetChange(beforeSet, AppLen.nextPageWaitMs, doc);
          if (changed) {
            await waitForFeedSettled(8000, doc);
            scrollFeedBottom(feed);
            return { more: true, advanced: true };
          }
        }
        const afterState = nextPageButtonState(doc);
        if (!afterState.exists || !afterState.enabled) {
          const late = await waitForArticleSetChange(beforeSet, 8000, doc);
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
        const added = await waitForArticleSetChange(beforeSet, 4500, doc);
        if (added) {
          await waitForFeedSettled(6000, doc);
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
      Adapter.navigate(buildSearchUrl(job.profession, job.currentArea));
    }

    function recordAreaSummary() {
      const key = 'gme_area_stats';
      const entry = {
        area: job.currentArea,
        extracted: job.areaCollected,
        rounds: job.scrollRound,
        at: nowIso()
      };
      Adapter.storageGet(key).then(function (result) {
        const list = result && result[key] ? result[key] : [];
        list.push(entry);
        Adapter.storageSet({ [key]: list });
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
        Adapter.sendMessage({ type: 'GME_FINISHED', state: jobStateSnapshot() });
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
        Adapter.sendMessage({ type: 'GME_ERROR', state: jobStateSnapshot(), message: job.error });
      } catch (error) {}
    }

    function handleAreaError(error) {
      const message = error && error.message ? error.message : String(error);
      if (!job) return;
      job.error = message;
      persistNow();
      setErrorState(message);
    }

    function startJob(payload) {
      const areas = parseAreas(payload);
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
        return loadFromStorage();
      }).then(function () {
        if (!job || job.status !== 'running') return { ok: false, reason: 'Job not active.' };
        runArea(globalThis.document);
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
            runArea(globalThis.document);
            return { ok: true, status: 'running' };
          });
        }
        job.status = 'running';
        setStatusDetail('Resuming...');
        persistNow();
        runArea(globalThis.document);
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
            Adapter.navigate(buildSearchUrl(job.profession, job.currentArea));
            return null;
          }
          if (job.status === 'paused') return null;
          setStatusDetail('Continuing extraction...');
          persistNow();
          runArea(globalThis.document);
          return null;
        });
      });
    }

    function getStateSummary() {
      return jobStateSnapshot();
    }

    return {
      startJob: startJob,
      pauseJob: pauseJob,
      resumeJob: resumeJob,
      stopJob: stopJob,
      resetJob: resetJob,
      onPageReady: onPageReady,
      getStateSummary: getStateSummary,
      loadJobRecords: loadJobRecords,
      rebuildSeenSet: rebuildSeenSet
    };
  }

  return {
    create: create,
    constants: {
      AppLen: AppLen,
      MapsDom: MapsDom,
      MapsText: MapsText,
      MapsExp: MapsExp,
      JobKeys: JobKeys
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrapeAlgorithm;
}