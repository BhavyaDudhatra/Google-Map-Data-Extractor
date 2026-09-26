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

function findDetailNameNode() {
  const seenNodes = new Set();
  for (const selector of MapsDom.detailName) {
    for (const node of findIn(document, selector)) {
      if (seenNodes.has(node)) continue;
      seenNodes.add(node);
      const text = cleanText(node.getAttribute('aria-label') || node.innerText || '');
      if (isValidNameText(text)) return node;
    }
  }
  return null;
}

function extractNameElement(root) {
  const node = findDetailNameNode();
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

function findInfoContainer() {
  const nameNode = findDetailNameNode();
  if (!nameNode) return null;
  let el = nameNode;
  let best = nameNode;
  for (let step = 0; step < 7 && el && el !== document.body; step++) {
    if (el.querySelector(MapsDom.feed)) break;
    best = el;
    el = el.parentElement;
  }
  return best;
}

function panelTextLines() {
  const container = findInfoContainer();
  const source = container || document.body;
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

function extractFullPanelText() {
  return dedupeLines(panelTextLines()).join('\n');
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
  const lines = panelTextLines();
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
  const lines = panelTextLines();
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

function bestCandidateText(elements) {
  let best = '';
  for (const el of elements) {
    const text = cleanText(el.innerText || el.textContent || '');
    if (text.length > best.length) best = text;
  }
  return best;
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
  const ctx = root || document;
  if (extractPhoneFromElement(ctx)) return true;
  if (extractAddressFromElement(ctx)) return true;
  if (extractWebsite(ctx)) return true;
  return false;
}

function pageBodyText() {
  return cleanText(document.body.innerText || '');
}

function isNoResultsPage() {
  const text = pageBodyText();
  for (const marker of MapsDom.noResultsMarkers) {
    if (text.indexOf(marker) !== -1) return true;
  }
  if (text.indexOf(MapsText.noLocations) !== -1) return true;
  return false;
}

function isBlockedPage() {
  const text = pageBodyText();
  for (const marker of MapsDom.blockedMarkers) {
    if (text.indexOf(marker) !== -1) return true;
  }
  return false;
}

function readResultCountFromPage() {
  const text = pageBodyText();
  const match = text.match(MapsExp.resultCountHeader);
  if (match) return Number(String(match[1]).replace(/[^\d]/g, ''));
  return 0;
}