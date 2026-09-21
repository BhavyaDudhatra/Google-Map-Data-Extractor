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

function isProbablyPhone(text) {
  const t = cleanText(text || '');
  if (!t || !/\d/.test(t)) return false;
  const lower = t.toLowerCase();
  const hasAddressWords = /(road|rd\.|street|st\.|lane|ln\.|nagar|society|colony|complex|tower|mall|plaza|building|cross|crossing|chowk|market|sector|phase|block|shop|office|floor|lvl|highway|hwy|opp|opposite|near|beside|layout|ext|main|bungalows?|plot)\b/i.test(lower);
  const hasComma = t.indexOf(',') !== -1;
  if (hasAddressWords && hasComma) return false;
  const digits = cleanPhoneDigits(t);
  if (digits.length < 7 || digits.length > 15) return false;
  if (/[a-z]/i.test(lower) && digits.length < 9) return false;
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
  const words = t.split(/\s+/).length;
  const hasDigits = /\d/.test(t);
  const hasComma = /,/.test(t);
  const hasAreaSuffix = /(nagar|ahmedabad|gandhinagar|surendranagar|surat|vadodara|rajkot|junagadh|bhavnagar|jamnagar|amreli|porbandar|bhuj|mandvi|anjar|kalol|mehsana|nadiad|anand|vidhyanagar|petlad|godhra|palanpur|itarsi|city|district|state)/i.test(t);
  const hint = MapsExp.addressHint.test(t);
  let score = 0;
  if (hasDigits) score += 2;
  if (hasComma) score += 2;
  if (hint) score += 3;
  if (hasAreaSuffix) score += 2;
  if (words >= 3) score += 1;
  if (isProbablyPhone(t)) return -50;
  return score;
}

function extractPhoneFromElement(root) {
  for (const selector of MapsDom.detailPhone) {
    const nodes = findIn(root, selector);
    for (const node of nodes) {
      const text = cleanText(node.innerText || node.getAttribute('href') || '');
      if (isProbablyPhone(text)) return text;
    }
  }
  return '';
}

function extractAddressFromElement(root) {
  for (const selector of MapsDom.detailAddress) {
    const nodes = findIn(root, selector);
    for (const node of nodes) {
      const text = cleanText(node.innerText || node.getAttribute('aria-label') || '');
      if (text && !/copy address/i.test(text) && text.length > 5 && addressScore(text) >= 2) return text;
    }
  }
  let addressLine = '';
  const headings = findIn(root, MapsDom.headingText);
  for (const heading of headings) {
    const h = cleanText(heading.innerText || '');
    if (MapsText.addressHeading === h.toLowerCase() || MapsText.addressLabel === h.toLowerCase()) {
      const sibling = heading.parentElement ? heading.parentElement.nextElementSibling : null;
      if (sibling) {
        const text = cleanText(sibling.innerText || '');
        if (text && addressScore(text) >= 1) return text;
      }
    }
  }
  return addressLine;
}

function extractNameElement(root) {
  for (const selector of MapsDom.detailName) {
    const node = root.querySelector(selector);
    if (node) {
      const text = cleanText(node.getAttribute('aria-label') || node.innerText || '');
      if (text) return text;
    }
  }
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
  const lines = text.split('|').map(function (l) { return cleanText(l); }).filter(Boolean);
  return lines;
}

function extractFromDetailPanel(root) {
  const name = extractNameElement(root);
  const phone = extractPhoneFromElement(root);
  let address = extractAddressFromElement(root);
  if (!address) {
    const lines = cleanText(root.innerText || '').split('\n').map(function (l) { return cleanText(l); }).filter(Boolean);
    let best = '';
    let bestScore = -1;
    for (const line of lines) {
      if (isProbablyPhone(line)) continue;
      const score = addressScore(line);
      if (score > bestScore) {
        bestScore = score;
        best = line;
      }
    }
    if (bestScore >= 4) address = best;
  }
  return { name: name, address: address, phone: phone };
}

function extractFromFeedItem(article) {
  const link = extractFeedLink(article);
  const url = link ? link.getAttribute('href') : '';
  const name = extractFeedName(article);
  const snapshot = extractFeedSnapshot(article);
  let address = '';
  for (const line of snapshot) {
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