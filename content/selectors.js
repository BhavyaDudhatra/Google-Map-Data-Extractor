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