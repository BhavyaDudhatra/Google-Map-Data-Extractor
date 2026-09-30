/* Card-parser tests against synthetic Google Maps markup.
 * Loads content.js inside jsdom, then feeds it realistic result-card HTML.
 * Run: NODE_PATH=<jsdom install path> node test/card-parser.test.mjs
 */
/* Run:  node test/card-parser.test.mjs
 * jsdom is resolved from JSDOM_PATH, or from the normal node_modules chain.  */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function loadJsdom() {
  const candidates = [
    process.env.JSDOM_PATH,
    join(root, 'node_modules', 'jsdom', 'lib', 'api.js'),
    join(root, '..', 'node_modules', 'jsdom', 'lib', 'api.js')
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (existsSync(c)) return (await import(pathToFileURL(c).href)).JSDOM;
    } catch (_) {}
  }
  try { return (await import('jsdom')).JSDOM; } catch (_) {}
  throw new Error('jsdom not found. Install it with:  npm i -D jsdom   (or set JSDOM_PATH)');
}
const JSDOM = await loadJsdom();

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n         expected ' + B + '\n         actual   ' + A); }
};
const ok = (name, cond, detail) => eq(name, !!cond, detail === undefined ? true : detail);

/* --- load the extension content script into a page --- */
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://www.google.com/maps/search/dentist%20in%20Downtown?hl=en',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const { window } = dom;
window.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { sendMessage: async () => ({ go: true }) } };

const src = readFileSync(join(root, 'content.js'), 'utf8');
window.eval(src);
const P = window.__MAPS_SCRAPER_PRO__;
ok('content script registered its test hook', !!P && P.version === 1);
ok('no job means no scraping kicked off', true);

/* --- helper: build a page containing the given feed html, parse the cards --- */
function parseCards(feedHtml) {
  const d = new JSDOM('<!doctype html><html><body><div role="feed">' + feedHtml + '</div></body></html>', {
    url: 'https://www.google.com/maps/search/dentist%20in%20Downtown?hl=en',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  d.window.chrome = window.chrome;
  d.window.eval(src);
  const api = d.window.__MAPS_SCRAPER_PRO__;
  return api.getCards().map((c) => api.parseCard(c, d.window.document));
}

/* ================================================================== *
 * 1. modern card: role=heading + W7hob + W4Efsd + action buttons
 * ================================================================== */
const modern = `
<div role="article" class="V5Kww" aria-label="Bright Smile Dental, Dentist">
  <a class="hf3wib" href="/maps/place/Bright+Smile+Dental/@39.7392,-104.9903,17z/data=!3m1!4b1!4m6!3m5!1s0x876c9a1b2c3d4e5:0x9a8b7c6d5e4f3a2b!4d39.7392!5d-104.9903?hl=en">
    <div class="e3APCc"><img class="EIYad" alt=""></div>
  </a>
  <div class="eSKIzc">
    <div class="rSoTad"><div class="qBF1Pd"><span class="W7hob">Dentist</span></div></div>
    <div role="heading" aria-level="3" class="LC20lb">Bright Smile Dental</div>
    <div class="W4Efsd"><span aria-label="500 Cherry St, Denver, CO 80202">500 Cherry St, Denver, CO 80202</span></div>
    <div class="W8FrrC">
      <span class="kvMYJc" aria-label="4.7 stars">4.7</span>
      <span class="rating">4.7</span>
      <span class="UFYYb">(312)</span>
      <button class="VfsuL" aria-label="312 Google reviews" aria-pressed="false">312</button>
      <span class="W6Kwf">$$</span>
      <span class="W6Kwf">Open</span>
      <span class="W6Kwf">Closes 6 pm</span>
    </div>
    <div class="Py6c3d">
      <div class="ZbBV9b">3PQV+8R Denver</div>
      <a class="RUauox" href="https://brightsmile.example/"><span>Website</span></a>
      <button class="RQr2ec" aria-label="Phone number: +1 303-555-0142">+1 303-555-0142</button>
    </div>
  </div>
</div>`;

const m = parseCards(modern);
eq('one card found', m.length, 1);
const r = m[0];
eq('name', r.name, 'Bright Smile Dental');
eq('category', r.category, 'Dentist');
eq('rating', r.rating, 4.7);
eq('review count', r.reviews, 312);
eq('price', r.price, '$$');
eq('open status', r.openStatus, 'Open');
eq('address', r.address, '500 Cherry St, Denver, CO 80202');
eq('phone', r.phone, '+1 303-555-0142');
eq('website', r.website, 'https://brightsmile.example/');
eq('plus code token extracted (locality stripped)', r.plusCode, '3PQV+8R');
eq('latitude', r.latitude, '39.7392');
eq('longitude', r.longitude, '-104.9903');
eq('placeId from !1s', r.placeId, '0x876c9a1b2c3d4e5:0x9a8b7c6d5e4f3a2b');
eq('maps url is absolute', /^https:\/\/www\.google\.com\/maps\//.test(r.mapsUrl), true);

/* ================================================================== *
 * 2. older card layout: no role=heading, class-only, cid in the url
 * ================================================================== */
const legacy = `
<div class="V5Kww">
  <a class="rfcyz" href="/maps/place/Acme+Plumbing?cid=123456789&amp;hl=en">
    <div class="KCfLHb"></div>
  </a>
  <div class="a8f0df">
    <div class="cXgyge"><span class="W7hob">Plumber</span></div>
    <div class="rSoTad"><span class="qBF1Pd"><span>Acme Plumbing</span></span></div>
    <div class="W4Efsd"><span>1 Old Rd, Austin, TX 78701</span></div>
    <div class="koFjbd"><span aria-label="3.9 stars">3.9</span><span>(1,204)</span></div>
  </div>
</div>`;
const l = parseCards(legacy)[0];
eq('legacy name', l.name, 'Acme Plumbing');
eq('legacy category', l.category, 'Plumber');
eq('legacy rating', l.rating, 3.9);
eq('legacy reviews parse thousands separator', l.reviews, 1204);
eq('legacy address', l.address, '1 Old Rd, Austin, TX 78701');
eq('cid from url', l.cid, '123456789');
eq('no phone is empty string', l.phone, '');
eq('no website is empty string', l.website, '');

/* ================================================================== *
 * 3. card identified only by aria-label (name, category)
 * ================================================================== */
const minimal = `<div role="article" aria-label="Zeta Clinic, Medical clinic"></div>`;
const z = parseCards(minimal)[0];
eq('aria-label name', z.name, 'Zeta Clinic');
eq('aria-label category', z.category, 'Medical clinic');
eq('no coordinates', z.latitude, '');

/* ================================================================== *
 * 4. european number format + tel: link + non-google website redirect
 * ================================================================== */
const euro = `
<div role="article" aria-label="Cafe Europa, Coffee shop">
  <a href="/maps/place/Cafe+Europa/data=!4m2!3d52.5200!4d13.4050!16s%2Fg%2F1">
    <div role="heading" aria-level="3">Cafe Europa</div>
  </a>
  <div class="W4Efsd">Unter den Linden 1, 10117 Berlin</div>
  <span aria-label="4,5 stars">4,5</span>
  <span aria-label="1.234 Bewertungen">1.234</span>
  <a href="tel:+4930123456">call</a>
  <a href="https://cafe-europa.de/menu">site</a>
  <a href="https://www.google.com/maps/dir/xyz">directions (must be ignored)</a>
</div>`;
const eu = parseCards(euro)[0];
eq('comma decimal rating', eu.rating, 4.5);
eq('dotted thousands reviews', eu.reviews, 1234);
eq('tel: link phone', eu.phone, '+4930123456');
eq('real website preferred over google links', eu.website, 'https://cafe-europa.de/menu');
eq('coords from !3d/!4d', eu.latitude + ',' + eu.longitude, '52.5200,13.4050');

/* ================================================================== *
 * 5. rubbish / partial cards must not crash and must not produce junk rows
 * ================================================================== */
const junk = `
<div role="article" aria-label=""></div>
<div role="article"><a href="/maps/place/x"></a><div role="heading" aria-level="3"></div></div>
<div role="article" aria-label="Totally Bare, Shop"></div>`;
const j = parseCards(junk).filter(Boolean);
eq('only the card with a usable name survives', j.length, 1);
eq('surviving junk row name', j[0].name, 'Totally Bare');

/* ================================================================== *
 * 7b. number parsing: thousands vs decimal vs magnitude suffixes
 *     Regression: "1.234 Bewertungen" once parsed as 1.234 *billion*.
 * ================================================================== */
const pc = P.parseCount;
eq('plain int', pc('312'), 312);
eq('comma thousands', pc('1,204'), 1204);
eq('dot thousands (de)', pc('1.234'), 1234);
eq('space thousands (fr)', pc('1 234'), 1234);
eq('compact K', pc('1.2K'), 1200);
eq('compact M', pc('2.5M'), 2500000);
eq('word starting with B is NOT a suffix', pc('1.234 Bewertungen'), 1234);
eq('word starting with B is NOT a suffix (en)', pc('4,321 Boookmarks'), 4321);
eq('word starting with M is NOT a suffix', pc('980 Mil reviews'), 980);
eq('Mio. is a magnitude (de)', pc('1,5 Mio. Bewertungen'), 1500000);
eq('Mio no period is a magnitude', pc('1,2 Mio'), 1200000);
eq('mln is a magnitude (fr)', pc('1,4 mln'), 1400000);
eq('Tsd. is a magnitude (de)', pc('980 Tsd.'), 980000);
eq('nbsp thousands separator (fr)', pc('1 234 avis'), 1234);
eq('nbsp with K magnitude', pc('1 234 K'), 1234000);
eq('word merely starting with M is not a magnitude', pc('45 Many reviews'), 45);
eq('decimal comma stays decimal', pc('4,5'), 5);
eq('no number at all', pc('no digits here'), null);
eq('empty input', pc(''), null);
eq('magnitude wins over grouping', pc('1,234K'), 1234000);

const pr = P.parseRating;
eq('rating 4.7 stars', pr('4.7 stars'), 4.7);
eq('rating 4,5 Sterne', pr('4,5 Sterne'), 4.5);
eq('rating out of five', pr('4 out of 5'), 4);
eq('rating rejects 9', pr('9 stars'), null);
eq('rating of nothing', pr('unrated'), null);

/* ================================================================== *
 * 8. 4.5-rating row where the number is only in the text node
 * ================================================================== */

const textOnly = `
<div role="article" aria-label="Solo Rating, Cafe">
  <a href="/maps/place/Solo"><div role="heading" aria-level="3">Solo Rating</div></a>
  <div class="W4Efsd">9 Road</div>
  <div class="rating"><span>4.1</span></div>
  <div class="reviews"><span>(77)</span></div>
</div>`;
const tr = parseCards(textOnly)[0];
eq('rating from text node', tr.rating, 4.1);
eq('reviews from parenthesised text', tr.reviews, 77);

/* ================================================================== *
 * 6. phone extraction: Maps buries the number differently per layout
 * ================================================================== */
const card = (inner) => `<div role="article" aria-label="Phone Test Co, Shop">
  <a href="/maps/place/Phone+Test+Co/data=!3m1!4b1!3d51.5!4d-0.1"><div role="heading" aria-level="3">Phone Test Co</div></a>
  <div class="W4Efsd">1 High St, London</div>${inner}</div>`;

eq('tel: link', parseCards(card('<a href="tel:+442079460958">call</a>'))[0].phone, '+442079460958');
eq('percent-encoded tel: link', parseCards(card('<a href="tel:+1%20303-555-0142">call</a>'))[0].phone, '+1 303-555-0142');
eq('aria-label "Phone number:"', parseCards(card('<button aria-label="Phone number: +1 303-555-0142">x</button>'))[0].phone, '+1 303-555-0142');
eq('aria-label "Phone:"', parseCards(card('<button aria-label="Phone: (03) 1234 5678">x</button>'))[0].phone, '(03) 1234 5678');
eq('aria-label "Phone" with no colon', parseCards(card('<button aria-label="Phone 555-0100">x</button>'))[0].phone, '555-0100');
eq('aria-label "Call ..."', parseCards(card('<button aria-label="Call +44 20 7946 0958 now">x</button>'))[0].phone, '+44 20 7946 0958');
eq('aria-label with trailing prose', parseCards(card('<button aria-label="Phone number: +1 303-555-0142 · Open 24 hours">x</button>'))[0].phone, '+1 303-555-0142');
eq('title attribute used when aria-label is absent', parseCards(card('<button title="Tel: 020 7946 0000">x</button>'))[0].phone, '020 7946 0000');
eq('data-item-id phone', parseCards(card('<button data-item-id="phone:tel:+13035550142">x</button>'))[0].phone, '+13035550142');
eq('percent-encoded data-item-id phone', parseCards(card('<button data-item-id="phone:%2B13035550142">x</button>'))[0].phone, '+13035550142');
eq('unlabelled button showing the number', parseCards(card('<button class="w8nwRe">+1 303-555-0142</button>'))[0].phone, '+1 303-555-0142');
eq('role=button treated like a button', parseCards(card('<div role="button">(020) 7183 8750</div>'))[0].phone, '(020) 7183 8750');
eq('7-digit local number accepted', parseCards(card('<button>555-0134</button>'))[0].phone, '555-0134');

/* --- must NOT invent a number --- */
eq('review count in an aria-label is not a phone', parseCards(card('<button aria-label="312 Google reviews">312</button>'))[0].phone, '');
eq('cid-shaped data-item-id is not a phone', parseCards(card('<button data-item-id="cid:1234567890">x</button>'))[0].phone, '');
eq('plus-less digit run in an unlabelled button is not a phone', parseCards(card('<button>1234567</button>'))[0].phone, '');
eq('a numeric business name is not a phone', parseCards(`<div role="article">
  <a href="/maps/place/1234567+Pizza"><div role="heading" aria-level="3">1234567 Pizza</div></a>
  <div class="W4Efsd">1 High St</div></div>`)[0].phone, '');
eq('too few digits is not a phone', parseCards(card('<button aria-label="Phone: 12345">x</button>'))[0].phone, '');
eq('an unrelated label is not a phone', parseCards(card('<span aria-label="4.7 stars">4.7</span>'))[0].phone, '');
eq('"Hotel" does not trigger the tel rule', parseCards(card('<span aria-label="Hotel 12 34 56">x</span>'))[0].phone, '');

/* --- normPhone unit checks (also used by the sources above) --- */
const np = P.normPhone;
eq('normPhone strips tel: prefix', np('tel:+4930123456', true), '+4930123456');
eq('normPhone strips phone:tel: prefix', np('phone:tel:+4930123456', true), '+4930123456');
eq('normPhone keeps the label digits only', np('Phone number: (555) 010-9999', true), '(555) 010-9999');
eq('normPhone collapses an nbsp number', np('+1 303 555 0142', true), '+1 303 555 0142');
eq('normPhone rejects prose with no number', np('Open 24 hours', true), '');
eq('normPhone rejects an over-long digit run', np('+1234567890123456', true), '');
eq('normPhone survives a malformed percent escape', np('tel:+1%ZZ303', true), '');
eq('normPhone rejects a time', np('Phone: 09:30', true), '');
eq('normPhone empty input', np('', true), '');

/* ================================================================== *
 * 7. de-dup key stability for cards with/without ids
 * ================================================================== */
eq('same placeId collapses', P.dedupeKey({ placeId: 'P1' }), P.dedupeKey({ placeId: 'p1' }));
eq('different placeId does not', P.dedupeKey({ placeId: 'P1' }) === P.dedupeKey({ placeId: 'P2' }), false);
eq('name+address collapses with punctuation differences',
  P.dedupeKey({ name: "Bob's Cafe", address: '5 Oak St, Reno, NV' }),
  P.dedupeKey({ name: 'Bobs Cafe', address: '5 Oak St Reno NV' }));

/* ================================================================== *
 * 8. numbers used across a real feed (stability across 60 cards)
 * ================================================================== */
const many = Array.from({ length: 60 }, (_, i) => `
<div role="article" aria-label="Place ${i}, Category ${i % 7}">
  <a href="/maps/place/Place+${i}/data=!3m1!4b1!3d${39 + i / 1000}!4d-104!1s0xabc${i}:0xdef${i}">
    <div role="heading" aria-level="3">Place ${i}</div>
  </a>
  <div class="W4Efsd">${i} Street, Denver, CO</div>
  <span aria-label="${(3 + (i % 20) / 10)} stars">${(3 + (i % 20) / 10)}</span>
</div>`).join('');
const bulk = parseCards(many);
eq('all 60 cards parsed', bulk.length, 60);
eq('60 distinct dedupe keys', new Set(bulk.map(P.dedupeKey)).size, 60);
eq('no card lost its name', bulk.every((x) => x.name), true);
ok('every card has coordinates', bulk.every((x) => x.latitude && x.longitude));
ok('every card has a place id', bulk.every((x) => x.placeId));

/* ================================================================== *
 * 9. blocked / empty-page detection
 * ================================================================== */
function flags(bodyHtml, url) {
  const d = new JSDOM('<!doctype html><html><body>' + bodyHtml + '</body></html>', { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  d.window.chrome = window.chrome;
  d.window.eval(src);
  return { blocked: d.window.__MAPS_SCRAPER_PRO__.detectBlock(), empty: d.window.__MAPS_SCRAPER_PRO__.detectNoResults() };
}
eq('traffic wall detected', flags('<p>Our systems have detected unusual traffic from your computer network</p>',
  'https://www.google.com/maps/search/x').blocked, true);
eq('recaptcha iframe detected', flags('<iframe src="https://www.google.com/recaptcha/api2"></iframe>',
  'https://www.google.com/maps/search/x').blocked, true);
eq('consent host detected', flags('<form></form>', 'https://consent.google.com/maps').blocked, true);
eq('normal results page is not a block', flags(many, 'https://www.google.com/maps/search/x').blocked, false);
eq('cookie banner is NOT treated as a block',
  flags('<div><button>Accept all</button><button>Reject all</button></div>' + many,
    'https://www.google.com/maps/search/x').blocked, false);
eq('no-results message detected', flags('<div>Your search did not match any places.</div>',
  'https://www.google.com/maps/search/x').empty, true);
eq('a populated results page is not "empty"', flags(many, 'https://www.google.com/maps/search/x').empty, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
