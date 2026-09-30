/* Maps Scraper Pro - content script
 * Runs inside the Google Maps tab. It is the long-lived orchestrator:
 * it drives navigation + scraping, persists progress to chrome.storage.local
 * after every area, and self-resumes after each page load.
 * The MV3 service worker only creates/repairs the tab and aggregates state,
 * so a killed service worker can never interrupt a long run.
 */
(() => {
  'use strict';

  if (window.__MAPS_SCRAPER_PRO__) return;

  const S_JOB = 'job';
  const S_STATE = 'state';
  const S_DATA = 'areaData';
  const S_CFG = 'config';
  const NAVMARK = 'gmx_nav_index';

  const DEFAULTS = {
    delayBetweenAreas: 6,      // seconds
    maxScrollSeconds: 75,      // per area
    stableRounds: 4,           // consecutive no-growth scrolls before stopping
    startDelaySeconds: 8,      // warm-up before the first area
    dedupe: true,
    stopOnBlocked: true        // pause the job if Google shows a captcha/consent wall
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const now = () => Date.now();

  /* ------------------------------------------------------------------ *
   * storage helpers
   * ------------------------------------------------------------------ */
  const get = (keys) => chrome.storage.local.get(keys);
  const set = (obj) => chrome.storage.local.set(obj);

  let stateCache = null;
  let flushTimer = null;
  let dirty = false;

  function queueFlush(immediate) {
    dirty = true;
    if (immediate) {
      /* An armed timer would otherwise swallow this and fire later against a
         newer state, so always cancel it when a write is demanded now. */
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flush();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (dirty) flush();
    }, 1500);
  }

  async function flush() {
    if (!stateCache) return;
    dirty = false;
    const snapshot = stateCache;
    try { await set({ [S_STATE]: snapshot }); } catch (_) { /* retried on the next tick */ }
  }

  function markArea(index, patch) {
    if (!stateCache) return;
    const a = stateCache.areas[index];
    if (a) Object.assign(a, patch);
    queueFlush();
  }

  /* ------------------------------------------------------------------ *
   * text helpers
   * ------------------------------------------------------------------ */
  const clean = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const normKey = (s) => clean(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  /* Digit-group separators Google can emit: , . ' and non-breaking space
     (fr-FR renders "1 234" with an nbsp). SEPCH holds the *contents* of a
     character class - do not wrap it in brackets before concatenating it into
     another class, or the outer class closes early and the regex breaks. */
  const SEPCH = ".,'\\s\\u00a0";

  function parseCount(raw) {
    if (!raw) return null;
    const s0 = String(raw);
    /* Capture the number run only. A magnitude token must be the whole word
       that follows, otherwise "1.234 Bewertungen" parses as 1.234 *billion*. */
    const m = s0.match(new RegExp('(\\d[\\d' + SEPCH + ']*\\d|\\d)'));
    if (!m) return null;
    let s = m[1].trim();
    const rest = s0.slice(m.index + m[0].length);

    const grouped = new RegExp('^\\d{1,3}([' + SEPCH + ']\\d{3})+$').test(s);
    /* "Mio." (de) / "mln" (fr) / "Tsd." are magnitudes; words that merely begin
       with B/M/K ("Bewertungen", "Milestones") are not. */
    const sufM = new RegExp('^[' + SEPCH + ']?(k|m|b|mio|mln|tsd)(?![A-Za-z])', 'i').exec(rest);

    if (sufM) {
      /* A magnitude token always wins: "1 234 K" is 1.234M, not 1234. The
         (?![A-Za-z]) lookahead already rules out words like "Bewertungen". */
      const n = grouped
        ? parseFloat(s.replace(new RegExp('[' + SEPCH + ']', 'g'), ''))
        : parseFloat(s.replace(new RegExp("[,'\\s\\u00a0]", 'g'), '.'));
      if (!isFinite(n)) return null;
      const suf = sufM[1].toLowerCase();
      const mult = suf === 'k' || suf === 'tsd' ? 1e3
        : suf === 'm' || suf === 'mio' || suf === 'mln' ? 1e6
        : 1e9;
      return Math.round(n * mult);
    }

    /* "1,234" / "1.234" / "1 234" are grouped thousands; "4,5" is a decimal. */
    if (grouped) s = s.replace(new RegExp('[' + SEPCH + ']', 'g'), '');
    else s = s.replace(new RegExp("[,'\\s\\u00a0]", 'g'), '.');

    const n = parseFloat(s);
    return isFinite(n) ? Math.round(n) : null;
  }

  function parseRating(raw) {
    if (!raw) return null;
    const m = String(raw).match(/(\d+(?:[.,]\d+)?)\s*(?:\/\s*5|\s*out of 5|\s*star)/i)
           || String(raw).match(/(\d+[.,]\d+)/);
    if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.'));
    return isFinite(v) && v >= 0 && v <= 5 ? v : null;
  }

  function findLeaf(root, predicate) {
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length === 0 && predicate(el)) return el;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * card parsing
   * ------------------------------------------------------------------ */
  const NUMERICISH = /^\s*[\d.,\s]+(stars?|reviews?|out of 5|\/\s*5)?\s*$/i;
  const PRICEISH = /^\s*(\$|€|£|¥|₹)?\s*(\$|€|£|¥|₹){0,4}\s*(·\s*(\$|€|£|¥|₹){1,4}\s*)?$/;
  const PLUSCODE = /^[A-Z0-9]{4,}\+[A-Z0-9]{1,3}(,[A-Z]{3})?\s*$/;
  const STREETISH = /^\d+\s+\S/;
  const PC_TOKEN = /[A-Z0-9]{4,}\+[A-Z0-9]{1,3}(?:,[A-Z]{3})?/;
  /* The search URL forces hl=en, but stay resilient if a page renders otherwise. */
  const STAR_RE = /star|stern|étoile|estrella|stella|stjer|звезд|星/i;
  const REVIEW_RE = /review|bewertung|recension|reseñ|avis|commentaire|recenz|評価|评论|리뷰|szemlé|recenzji/i;
  /* Every layout words the action differently: "Phone number:", "Phone:",
     "Call ...", "Telefon:", "Anrufen", "Contact". \b keeps "Hotel" out.
     hl=en is forced on the search URL, so English alone is enough. */
  const PHONE_LABEL_RE = /phone|\bcall\b|\btel\b|\btelefon|\btéléphone|\btelefono|\banruf|\bkontakt|contact|whatsapp|\bmobil|\bmobile/i;
  const PHONE_MIN_DIGITS = 7;
  const PHONE_MAX_DIGITS = 15;

  function safeDecode(s) {
    try { return decodeURIComponent(String(s || '')); } catch (_) { return String(s || ''); }
  }

  /* Pull the number out of whatever Maps wrapped it in - a url ("tel:+1%20303"),
     a data-item-id ("phone:tel:+13035550142"), a label ("Phone number: +1 303-555-0142")
     or a button's text - and return '' unless what is left really is a number.
     `trusted` relaxes the shape check for markup already tagged as a phone, where
     a bare digit run like +13035550142 is normal; the untrusted text fallback
     keeps the stricter rule so a review count or a shop name cannot pass. */
  function normPhone(raw, trusted) {
    const s = clean(safeDecode(raw)
      .replace(/^tel:/i, '')
      .replace(/^phone:[\s:_-]*(?:tel:)?/i, '')
      .replace(/^tel:[\s:_-]*/i, ''));
    if (!s) return '';

    /* Split on characters that cannot occur in a number so a label with prose
       around it still yields the number alone, then take the first run that
       passes validation. */
    for (const part of s.split(/[^\d+()\u00a0.\- ]+/g)) {
      const cand = clean(part).replace(/^[\s.]+/, '').replace(/[\s.\-]+$/, '');
      if (!cand) continue;
      const digits = cand.replace(/\D/g, '');
      if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) continue;
      /* Untagged text must look formatted: an unseparated 7-15 digit run is far
         more often a review count, an opening hour or a rating. */
      if (!trusted && !/^\+|[-().\u00a0 ]/.test(cand)) continue;
      return cand;
    }
    return '';
  }

  function parseCard(card) {
    const aria = clean(card.getAttribute('aria-label'));

    /* ---- place link / ids / coordinates ---- */
    let href = '';
    const link =
      card.querySelector('a[href*="/maps/place"]') ||
      card.querySelector('a[href*="/maps/search"]') ||
      card.closest('a[href]') ||
      card.querySelector('a[href]');
    if (link) href = link.getAttribute('href') || '';

    let placeId = '';
    const pidFromHref = href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    if (pidFromHref) placeId = pidFromHref[1].toLowerCase();
    if (!placeId) {
      const item = card.querySelector('[data-item-id^="place:"], [data-item-id^="mid:"]');
      const v = item && item.getAttribute('data-item-id');
      if (v) placeId = v.replace(/^(place|mid):/, '').toLowerCase();
    }
    let cid = (href.match(/[?&]cid=(\d+)/) || [])[1] || '';
    if (!cid) {
      const item = card.querySelector('[data-item-id*="cid:"]');
      const v = item && item.getAttribute('data-item-id');
      if (v) cid = (v.match(/cid:(\d+)/) || [])[1] || '';
    }
    const ftid = (href.match(/[?&]ftid=([\w-]+)/) || [])[1] || '';

    let latitude = '', longitude = '';
    const c1 = href.match(/!3d(-?\d+(?:\.\d+)?)[^!]{0,24}!4d(-?\d+(?:\.\d+)?)/);
    if (c1) { latitude = c1[1]; longitude = c1[2]; }
    else {
      const c2 = href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),\d+z?/);
      if (c2) { latitude = c2[1]; longitude = c2[2]; }
    }

    /* ---- category is resolved first: on cards without a heading element the
            category span comes before the name in document order, and a naive
            "first text leaf wins" fallback would return the category. ---- */
    let category = '';
    const catEl =
      card.querySelector('[class*="W7hob"]') ||
      card.querySelector('[class*="rsw1Be"]');
    if (catEl) category = clean(catEl.textContent);
    if (!category) {
      const h = card.querySelector('[role="heading"][aria-level]') || card.querySelector('div[role="heading"]');
      if (h && h.nextElementSibling) category = clean(h.nextElementSibling.textContent);
    }
    if (!category && aria) {
      const i = aria.indexOf(',');
      if (i > 0 && i < aria.length - 1) category = clean(aria.slice(i + 1)).replace(/\s*\d+[,.]?\d*\s*\(?\d*[,.]?\d*\s*(stars?|reviews?)?\)?\s*$/i, '');
    }
    if (category && (PRICEISH.test(category) || NUMERICISH.test(category) || category.length > 90)) category = '';

    /* ---- name ---- */
    let name = '';
    const nameCandidates = [
      card.querySelector('[role="heading"][aria-level]'),
      card.querySelector('div[role="heading"]'),
      card.querySelector('h2'),
      card.querySelector('h3')
    ];
    for (const el of nameCandidates) {
      const t = clean(el && el.textContent);
      if (t && t.length <= 140 && t !== category && !NUMERICISH.test(t) && !PRICEISH.test(t)) { name = t; break; }
    }
    if (!name && link) {
      const t = clean(link.textContent);
      if (t && t.length <= 140 && t !== category && !NUMERICISH.test(t)) name = t;
    }
    if (!name) {
      const leaf = findLeaf(card, (el) => {
        if (catEl && catEl.contains(el)) return false;
        const t = clean(el.textContent);
        if (!t || t === category) return false;
        if (t.length < 2 || t.length > 90) return false;
        if (NUMERICISH.test(t) || PRICEISH.test(t) || STREETISH.test(t)) return false;
        if (/^(open|closed|permanently closed)$/i.test(t)) return false;
        if (PLUSCODE.test(t)) return false;
        return true;
      });
      if (leaf) name = clean(leaf.textContent);
    }
    if (!name && aria) name = clean(aria.split(/,\s(?=[A-Z])/)[0]);
    if (!name) return null;

    /* ---- rating / reviews ---- */
    let rating = '', ratingCount = '';
    for (const el of card.querySelectorAll('[aria-label]')) {
      const al = clean(el.getAttribute('aria-label'));
      if (!rating && STAR_RE.test(al)) { const v = parseRating(al); if (v !== null) rating = v; }
      if (!ratingCount && REVIEW_RE.test(al)) {
        const v = parseCount(al);
        if (v !== null) ratingCount = v;
      }
    }
    if (rating === '') {
      const leaf = findLeaf(card, (el) => {
        const t = clean(el.textContent);
        return /^\d+[.,]\d+$/.test(t) && t.length <= 5;
      });
      if (leaf) { const v = parseFloat(clean(leaf.textContent).replace(',', '.')); if (v > 0 && v <= 5) rating = v; }
    }
    if (ratingCount === '') {
      const m = clean(card.textContent).match(/\(([\d.,]+[KkMm]?)\)/) || clean(card.textContent).match(/([\d.,]+[KkMm]?)\s+reviews?/i);
      if (m) ratingCount = parseCount(m[1]);
    }

    /* ---- address ---- */
    let address = '';
    const addrSelectors = [
      '[aria-label^="Address:"]', '[aria-label^="Address "]',
      '[class*="W4Efsd"]', '[class*="W4Efsd"] span', '[class*="fontBodySmall"]'
    ];
    for (const sel of addrSelectors) {
      const el = card.querySelector(sel);
      const t = clean(el && el.textContent);
      if (t && t.length > 3 && t.length <= 220 && !/^(open|closed)/i.test(t) && !PRICEISH.test(t)) { address = t; break; }
    }
    if (!address) {
      const el = findLeaf(card, (e) => {
        const al = clean(e.getAttribute('aria-label') || '');
        if (al && (STREETISH.test(al) || /,\s*[A-Z]{2}(,|\s|$)/.test(al)) && al.length < 220 && !/star|review/i.test(al)) return true;
        return false;
      });
      if (el) address = clean(el.getAttribute('aria-label'));
    }
    if (!address && streetishText(card)) address = streetishText(card);
    address = address.replace(/^Address:\s*/i, '').trim();

    /* ---- phone ----
     * Maps buries the number differently on nearly every layout, so try the
     * explicit machine-readable sources first and only then fall back to reading
     * an unlabelled button. Every path ends in normPhone, so a lookalike string
     * is dropped rather than exported. */
    let phone = '';
    for (const a of card.querySelectorAll('a[href^="tel:"], a[href^="TEL:"]')) {
      phone = normPhone(a.getAttribute('href'), true);
      if (phone) break;
    }
    if (!phone) {
      for (const el of card.querySelectorAll('[aria-label], [title]')) {
        const al = clean(el.getAttribute('aria-label') || el.getAttribute('title'));
        if (!PHONE_LABEL_RE.test(al)) continue;
        phone = normPhone(al, true);
        if (phone) break;
      }
    }
    if (!phone) {
      for (const el of card.querySelectorAll('[data-item-id]')) {
        const v = clean(el.getAttribute('data-item-id'));
        if (!/^(?:phone|tel|telephone|mobile)[\s:_-]/i.test(v)) continue;
        phone = normPhone(v, true);
        if (phone) break;
      }
    }
    if (!phone) {
      /* An unlabelled action button simply shows the number. Only buttons are
         read: the text of the place link is the business name, and a name made
         of digits would otherwise look like a phone. */
      for (const b of card.querySelectorAll('button, [role="button"]')) {
        if (b.querySelector('[role="heading"]')) continue;
        phone = normPhone(clean(b.textContent), false);
        if (phone) break;
      }
    }

    /* ---- website ---- */
    let website = '';
    const anchors = card.querySelectorAll('a[href]');
    for (const a of anchors) {
      const h = a.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(h)) continue;
      if (/\/maps\/|google\.[a-z.]+\//i.test(h)) continue;
      website = h;
      break;
    }
    if (!website) {
      const btn = card.querySelector('[aria-label^="Website:"], [aria-label^="Website "]');
      if (btn) website = clean(btn.getAttribute('aria-label')).replace(/^Website:\s*/i, '');
    }
    if (!website) {
      const it = card.querySelector('[data-item-id^="website:"]');
      if (it) website = it.getAttribute('data-item-id').replace(/^website:/, '');
    }
    if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website.replace(/^\/+/, '');

    /* ---- open status / price / plus code ---- */
    let openStatus = '';
    for (const el of card.querySelectorAll('[aria-label], span, div')) {
      const al = clean(el.getAttribute('aria-label') || '');
      if (/^(open|closed|permanently closed)\b/i.test(al)) { openStatus = al; break; }
      if (!openStatus && el.children.length === 0) {
        const t = clean(el.textContent);
        if (/^(open|closed|permanently closed)$/i.test(t)) { openStatus = t; break; }
        if (/^(opens? \d|closing soon|opens? at)/i.test(t)) { openStatus = t; break; }
      }
    }

    let price = '';
    for (const el of card.querySelectorAll('div, span')) {
      if (el.children.length) continue;
      const t = clean(el.textContent);
      if (t && t.length <= 12 && PRICEISH.test(t) && /[$€£¥₹]/.test(t)) { price = t; break; }
    }
    if (!price) {
      const m = clean(card.textContent).match(/(?:^|\s)(\$+(\s?·\s?\$+)?)(?:\s|$)/);
      if (m) price = m[1].replace(/\s+/g, '');
    }

    /* Maps shows the plus code as a chip or appended to the address line. */
    let plusCode = '';
    const pcEl = card.querySelector('[aria-label^="Plus code"], [class*="RZuyXd"], [class*="r6Zt1e"], [class*="ZbBV9b"]');
    if (pcEl) {
      const m = clean(pcEl.getAttribute('aria-label') || pcEl.textContent).match(PC_TOKEN);
      if (m) plusCode = m[0];
    }
    if (!plusCode) {
      const m = clean(card.textContent).match(PC_TOKEN);
      if (m) plusCode = m[0];
    }

    /* ---- service / attribute chips ---- */
    const chips = [];
    for (const el of card.querySelectorAll('[class*="OjJFf"], [class*="w8UdsB"]')) {
      const t = clean(el.textContent);
      if (t && t.length <= 28 && chips.length < 8) chips.push(t);
    }

    const absUrl = href ? new URL(href, location.origin).toString() : '';
    const mapsLink = placeId
      ? `https://www.google.com/maps/search/?api=1&query=${latitude ? latitude + ',' + longitude : encodeURIComponent(name)}&query_place_id=${encodeURIComponent(placeId)}`
      : absUrl || `https://www.google.com/maps/search/${encodeURIComponent(name)}`;

    return {
      name,
      category,
      rating: rating === '' ? '' : rating,
      reviews: ratingCount === '' ? '' : ratingCount,
      price,
      openStatus,
      address,
      phone,
      website,
      plusCode,
      latitude,
      longitude,
      placeId,
      cid,
      ftid,
      mapsUrl: mapsLink,
      chips: chips.join(', ')
    };
  }

  function streetishText(card) {
    const leaves = card.querySelectorAll('span, div');
    for (const el of leaves) {
      if (el.children.length) continue;
      const t = clean(el.textContent);
      if (t.length > 6 && t.length < 220 && STREETISH.test(t) && /,/.test(t) && !/star|review/i.test(t)) return t;
    }
    return '';
  }

  /* ------------------------------------------------------------------ *
   * page plumbing
   * ------------------------------------------------------------------ */
  const BLOCK_PATTERNS = [
    /unusual traffic/i,
    /our systems have detected/i,
    /i'?m not a robot/i,
    /detected unusual traffic from your computer network/i
  ];

  function detectBlock() {
    if (location.hostname.startsWith('consent.')) return true;
    if (/\/sorry\//.test(location.pathname)) return true;
    if (document.querySelector('form[action*="consent"], iframe[src*="recaptcha"], #captcha-form, [data-qa*="captcha"]')) return true;
    return BLOCK_PATTERNS.some((re) => re.test(pageText(0, 4000)));
  }

  /* innerText is layout-aware but not universally available; textContent always is. */
  function pageText(from, to) {
    const b = document.body;
    if (!b) return '';
    return clean(b.innerText || b.textContent || '').slice(from, to);
  }

  function detectNoResults() {
    const t = pageText(0, 6000);
    return (
      /did not match any places/i.test(t) ||
      /your search did not match/i.test(t) ||
      /no results (were )?found/i.test(t) ||
      /找不到.*(地点|结果)/.test(t) ||
      /aucun résultat/i.test(t)
    );
  }

  function getFeed() {
    return document.querySelector('div[role="feed"]');
  }

  function getCards() {
    const feed = getFeed();
    if (!feed) return [];
    const arts = feed.querySelectorAll('div[role="article"], .V5Kww, [data-ved][aria-label][jsaction]');
    if (arts.length) return Array.from(arts);
    return Array.from(feed.children).filter((c) => c.querySelector('a[href]') || c.getAttribute('aria-label'));
  }

  function findScroller(feed) {
    let best = null;
    let node = feed;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      const st = getComputedStyle(node);
      const scrollable = node.scrollHeight - node.clientHeight > 60;
      if (scrollable && /(auto|scroll|overlay)/.test(st.overflowY)) {
        if (!best || node.scrollHeight > best.scrollHeight) best = node;
      }
      node = node.parentElement;
      depth++;
    }
    if (best) return best;
    return document.scrollingElement || document.documentElement;
  }

  async function waitForFeed(timeoutMs) {
    const start = now();
    let blockChecked = false;
    while (now() - start < timeoutMs) {
      /* Results on screen always win: a cookie/consent banner overlay must
         never be mistaken for a block. */
      const feed = getFeed();
      if (feed && getCards().length > 0) return 'ok';
      if (detectNoResults()) return 'empty';

      /* Only after a few seconds without a feed is it fair to suspect a wall. */
      if (!blockChecked && now() - start > 4000) {
        if (detectBlock()) return 'blocked';
        blockChecked = true;
      }
      await sleep(500);
    }
    if (detectBlock()) return 'blocked';
    return getFeed() ? 'ok' : 'empty';
  }

  async function clickMoreIfPresent() {
    for (const btn of document.querySelectorAll('button, div[role="button"], a')) {
      const t = clean(btn.textContent);
      if (!t) continue;
      if (/^(see more results|more results|show more results|see more|show more)$/i.test(t) && btn.offsetParent !== null) {
        btn.click();
        await sleep(1500);
        return true;
      }
    }
    return false;
  }

  function signature() {
    const cards = getCards();
    return cards
      .map((c) => {
        const a = c.querySelector('a[href*="/maps/place"], a[href*="/maps/search"]');
        return a ? (a.getAttribute('href') || '').slice(0, 120) : clean(c.getAttribute('aria-label')).slice(0, 80);
      })
      .join('|');
  }

  /* ------------------------------------------------------------------ *
   * the scrape for a single area
   * ------------------------------------------------------------------ */
  async function scrapeArea(areaLabel) {
    const startedAt = now();
    const budgetMs = Math.max(15, stateCache.config.maxScrollSeconds) * 1000;
    const stableNeeded = Math.max(2, stateCache.config.stableRounds);

    const feedStatus = await waitForFeed(45000);
    if (feedStatus === 'blocked') return { status: 'blocked', results: [], ms: now() - startedAt };
    if (feedStatus === 'empty') {
      if (detectBlock()) return { status: 'blocked', results: [], ms: now() - startedAt };
      return { status: 'empty', results: [], ms: now() - startedAt };
    }

    /* The scroll budget starts once results are on screen. Timing it from the
       top would let a slow feed consume the whole budget and return one page. */
    const t0 = now();

    const feed = getFeed();
    const scroller = findScroller(feed);

    let stable = 0;
    let lastSig = signature();
    let lastCount = getCards().length;
    let blocked = false;
    let aborted = false;

    while (now() - t0 < budgetMs) {
      /* Pause / Stop must take effect within one scroll tick, not one whole area. */
      if (!stateCache || stateCache.status !== 'running') { aborted = true; break; }

      if (stable > 0) {
        const more = await clickMoreIfPresent();
        if (more) { stable = 0; lastSig = signature(); }
      }

      const target = scroller.scrollHeight;
      scroller.scrollTop = target;
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: rnd(1200, 2600), bubbles: true, cancelable: true }));
      if (document.scrollingElement && document.scrollingElement !== scroller) {
        document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
      }

      await sleep(rnd(1100, 1900));

      if (document.querySelector('iframe[src*="recaptcha"]')) { blocked = true; break; }

      const sig = signature();
      const count = getCards().length;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80;

      if (count === lastCount && sig === lastSig && atBottom) stable++;
      else if (count > lastCount || sig !== lastSig) stable = 0;

      lastSig = sig;
      lastCount = count;

      stateCache.heartbeatAt = now();
      queueFlush();

      if (stable >= stableNeeded) break;
    }

    if (aborted) return { status: 'aborted', results: [], ms: now() - t0 };
    if (blocked) return { status: 'blocked', results: [], ms: now() - t0 };

    /* ---- harvest ---- */
    const seen = new Set();
    const out = [];
    for (const card of getCards()) {
      let rec;
      try { rec = parseCard(card, document); } catch (_) { rec = null; }
      if (!rec || !rec.name) continue;
      const key = dedupeKey(rec);
      if (seen.has(key)) continue;
      seen.add(key);
      rec.area = areaLabel;
      out.push(rec);
    }
    return { status: out.length ? 'done' : 'empty', results: out, ms: now() - t0 };
  }

  function dedupeKey(r) {
    if (r.placeId) return 'p:' + String(r.placeId).toLowerCase();
    if (r.cid) return 'c:' + r.cid;
    if (r.ftid) return 'f:' + r.ftid;
    return 'n:' + normKey(r.name) + '|' + normKey(r.address || '') + '|' + (r.phone || '').replace(/\D/g, '');
  }

  /* ------------------------------------------------------------------ *
   * url building
   * ------------------------------------------------------------------ */
  function searchUrl(job, area) {
    const q = `${job.profession} in ${area}`;
    return `${job.mapsBase}/search/${encodeURIComponent(q)}?hl=en`;
  }

  /* Google Maps rewrites the URL we navigate to: it re-encodes the query path
     using "+" for spaces and may add a trailing slash, so a raw path compare
     never matches and every area would be reported as a navigation failure. */
  function normPath(p) {
    let s = String(p || '').replace(/\+/g, '%20');
    try { s = decodeURIComponent(s); } catch (_) { /* leave as-is if malformed */ }
    return s.replace(/\/+$/, '').toLowerCase();
  }

  function isSameTarget(job, index) {
    /* Primary signal: this tab deliberately navigated here. sessionStorage
       survives same-tab navigations, so it is immune to Maps rewriting its URL. */
    try {
      if (sessionStorage.getItem(NAVMARK) === String(index)) return true;
    } catch (_) {}

    const want = searchUrl(job, job.areas[index]);
    try {
      return normPath(new URL(want).pathname) === normPath(location.pathname);
    } catch (_) {
      return false;
    }
  }

  function markNav(index) {
    try { sessionStorage.setItem(NAVMARK, String(index)); } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * job loop
   * ------------------------------------------------------------------ */
  async function runJob() {
    const store = await get([S_JOB, S_STATE, S_CFG]);
    const job = store[S_JOB];
    let state = store[S_STATE];
    if (!job || !state) return;
    if (state.status === 'done' || state.status === 'stopped' || state.status === 'idle') return;

    const config = Object.assign({}, DEFAULTS, store[S_CFG] || {}, state.config || {});
    state.config = config;
    stateCache = state;

    /* heartbeat keeps the watchdog in the service worker informed */
    const beat = setInterval(() => {
      if (!stateCache) return;
      stateCache.heartbeatAt = now();
      queueFlush();
    }, 5000);

    /* Pause/Stop are pressed in the popup, which writes `status` to storage.
       The scraper's abort check reads stateCache, so mirror external status
       changes into it - otherwise Pause would not take effect until the
       current area finished scrolling (up to maxScrollSeconds). */
    const onChanged = (changes, area) => {
      if (area !== 'local' || !changes[S_STATE]) return;
      const next = changes[S_STATE].newValue;
      if (!stateCache || !next) return;
      if (next.status !== stateCache.status) stateCache.status = next.status;
      if (typeof next.currentArea === 'string') stateCache.currentArea = next.currentArea;
    };
    if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(onChanged);

    try {
      /* ---- single-instance claim ---- */
      let allowed = true;
      try {
        const res = await chrome.runtime.sendMessage({ type: 'CLAIM' });
        allowed = !!(res && res.go);
      } catch (_) { /* service worker asleep: assume allowed */ }
      if (!allowed) return;

      for (;;) {
        /* Re-read the authoritative state every pass. The popup owns `status`:
           if it flipped us to paused/stopped we must not write 'running' back. */
        const fresh = (await get(S_STATE))[S_STATE];
        if (!fresh || fresh.status !== 'running') return;
        Object.assign(stateCache, fresh);
        stateCache.config = config;

        const i = stateCache.currentIndex;

        if (i >= job.areas.length) {
          stateCache.status = 'done';
          stateCache.finishedAt = now();
          stateCache.currentArea = '';
          stateCache.navForIndex = -1;
          await flush();
          chrome.runtime.sendMessage({ type: 'JOB_FINISHED' }).catch(() => {});
          return;
        }

        if (!isSameTarget(job, i)) {
          if (stateCache.navForIndex === i) {
            /* We already tried to load this area once and the page we ended up
               on is not it. Give up on it rather than reload-looping forever. */
            markArea(i, { status: 'error', error: 'Navigation failed - could not open the Maps search for this area.' });
            stateCache.navForIndex = -1;
            stateCache.currentIndex = i + 1;
            try { sessionStorage.removeItem(NAVMARK); } catch (_) {}
            await flush();
            continue;
          }
          stateCache.navForIndex = i;
          stateCache.currentArea = job.areas[i];
          markArea(i, { status: 'running' });
          await flush();
          markNav(i);
          location.replace(searchUrl(job, job.areas[i]));
          return; /* the new page load continues the job */
        }

        /* ---- we are on the right page: scrape it ---- */
        stateCache.navForIndex = -1;
        stateCache.currentArea = job.areas[i];
        markArea(i, { status: 'running' });
        await flush();

        if (config.startDelaySeconds > 0 && !stateCache.warmedUp) {
          stateCache.warmedUp = true;
          await sleep(rnd(config.startDelaySeconds * 500, config.startDelaySeconds * 1000));
        }

        const out = await scrapeArea(job.areas[i]);

        /* Paused/stopped mid-area: put the area back in the queue and idle.
           Deliberately no status write - the popup owns it. */
        if (out.status === 'aborted') {
          markArea(i, { status: 'pending' });
          stateCache.currentArea = '';
          await flush();
          return;
        }

        if (out.status === 'blocked') {
          if (config.stopOnBlocked) {
            markArea(i, { status: 'error', error: 'Blocked by Google (captcha / consent).' });
            stateCache.status = 'paused';
            stateCache.currentArea = '';
            stateCache.pausedAt = now();
            await flush();
            chrome.runtime.sendMessage({ type: 'JOB_PAUSED', area: job.areas[i] }).catch(() => {});
            return;
          }
          markArea(i, { status: 'error', error: 'Blocked by Google - skipped.' });
        } else {
          const { areaData } = await get(S_DATA);
          const data = areaData || {};
          data[i] = out.results;
          await set({ [S_DATA]: data });
          markArea(i, {
            status: out.status === 'empty' ? 'empty' : 'done',
            found: out.results.length,
            ms: out.ms || 0
          });
        }

        stateCache.currentIndex = i + 1;
        try { sessionStorage.removeItem(NAVMARK); } catch (_) {}
        await flush();

        if (stateCache.currentIndex < job.areas.length) {
          const wait = Math.max(0, config.delayBetweenAreas) * 1000;
          await sleep(rnd(wait * 0.7, wait * 1.35));
        }
      }
    } catch (err) {
      if (stateCache) {
        /* Only claim 'error' if we still own the run - never override a pause
           or a stop the user just requested. */
        const cur = (await get(S_STATE))[S_STATE];
        if (cur && cur.status === 'running') {
          stateCache.status = 'error';
          stateCache.error = String((err && err.message) || err);
          await flush();
        }
      }
    } finally {
      clearInterval(beat);
      if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.removeListener(onChanged);
      stateCache = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */
  function waitForBody() {
    if (document.body) return Promise.resolve();
    return new Promise((res) => {
      const t = setInterval(() => {
        if (document.body) { clearInterval(t); res(); }
      }, 50);
    });
  }

  (async function boot() {
    /* Exposed on the isolated-world window purely for the unit tests in /test.
       The Google Maps page can never see this object. */
    window.__MAPS_SCRAPER_PRO__ = {
      version: 1,
      clean,
      normKey,
      parseCount,
      parseRating,
      parseCard,
      dedupeKey,
      normPhone,
      detectNoResults,
      detectBlock,
      getCards,
      findScroller
    };

    await waitForBody();
    /* Google Maps swaps the whole document on deep links; wait a beat. */
    await sleep(400);
    try { await runJob(); } catch (_) { /* retried on the next page load / watchdog */ }
  })();
})();
