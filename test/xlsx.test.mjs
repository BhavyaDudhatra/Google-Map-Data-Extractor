/* End-to-end check of the Excel writer: builds the exact workbook popup.js
 * produces, then reads it back and asserts the structure.  node test/xlsx.test.mjs
 */
import { createRequire } from 'node:module';
import { mergeAreaData, areaSummary, EXPORT_COLUMNS } from '../lib/merge.js';

const require = createRequire(import.meta.url);
const XLSX = require('../lib/xlsx.full.min.js');

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  expected ' + B + ' got ' + A); }
};

/* --- fixture: 2 areas, 5 raw hits, 2 of them repeats of an earlier area --- */
const areas = [
  { name: 'Downtown', status: 'done', found: 3, ms: 41000 },
  { name: 'Midtown',  status: 'done', found: 2, ms: 38500 }
];
const areaData = {
  0: [
    { name: 'Blue Cafe', category: 'Cafe', rating: 4.5, reviews: 210, price: '$$', openStatus: 'Open',
      address: '1 A St, Denver, CO 80202', phone: '+1 303-555-0001', website: 'https://blue.example',
      areas: [], placeId: 'pA', cid: '11', latitude: '39.7392', longitude: '-104.9903',
      plusCode: '7J9V+42 Denver', mapsUrl: 'https://maps/pA', chips: 'Dine-in, Wifi' },
    { name: 'Red Gym', category: 'Gym', rating: 4, reviews: 90, price: '$', openStatus: 'Closed',
      address: '2 B St, Denver, CO 80202', phone: '303-555-0002', website: '', areas: [],
      placeId: 'pB', cid: '12', latitude: '39.7400', longitude: '-104.9900', plusCode: '',
      mapsUrl: 'https://maps/pB', chips: '' },
    { name: 'Green Salon', category: 'Salon', rating: '', reviews: '', price: '', openStatus: '',
      address: '3 C St, Denver, CO 80202', phone: '', website: '', areas: [],
      placeId: 'pC', cid: '13', latitude: '39.7410', longitude: '-104.9910', plusCode: '',
      mapsUrl: 'https://maps/pC', chips: '' }
  ],
  1: [
    { name: 'Red Gym', category: 'Gym', rating: '', reviews: '', price: '$', openStatus: 'Closed',
      address: '2 B St, Denver, CO 80202', phone: '303-555-0002', website: '', areas: [],
      placeId: 'pB', cid: '12', latitude: '39.7400', longitude: '-104.9900', plusCode: '',
      mapsUrl: 'https://maps/pB', chips: '' },
    { name: 'Yellow Deli', category: 'Deli', rating: 3.5, reviews: 45, price: '$', openStatus: 'Open',
      address: '4 D St, Denver, CO 80202', phone: '303-555-0004', website: 'https://yellow.example',
      areas: [], placeId: 'pD', cid: '14', latitude: '39.7420', longitude: '-104.9920', plusCode: '',
      mapsUrl: 'https://maps/pD', chips: 'Takeout' }
  ]
};

const merged = mergeAreaData(areas, areaData, true);
const summary = areaSummary(areas, areaData);

/* === build the workbook exactly as popup.js does === */
const head = EXPORT_COLUMNS.map((c) => c.header);
const aoa = [head].concat(merged.rows.map((r) => EXPORT_COLUMNS.map((c) => {
  const v = r[c.key];
  if (c.key === 'rating' || c.key === 'latitude' || c.key === 'longitude') {
    const n = parseFloat(v);
    return isFinite(n) && v !== '' ? n : '';
  }
  if (c.key === 'reviews' || c.key === 'areaCount' || c.key === 'row') {
    const n = parseInt(v, 10);
    return isFinite(n) ? n : '';
  }
  return v === undefined || v === null ? '' : v;
})));

const wb = XLSX.utils.book_new();
const ws1 = XLSX.utils.aoa_to_sheet(aoa);
ws1['!cols'] = EXPORT_COLUMNS.map((c) => ({ wch: c.width }));
ws1['!autofilter'] = { ref: XLSX.utils.encode_range({
  s: { r: 0, c: 0 }, e: { r: Math.max(0, aoa.length - 1), c: EXPORT_COLUMNS.length - 1 }
}) };
XLSX.utils.book_append_sheet(wb, ws1, 'Businesses');

const aHead = ['Area', 'Status', 'Results', 'Unique', 'With Phone', 'With Website', 'With Rating', 'Seconds', 'Note'];
const ws2 = XLSX.utils.aoa_to_sheet([aHead].concat(
  summary.map((r) => [r.area, r.status, r.results, r.unique, r.withPhone, r.withWebsite, r.withRating, r.seconds, r.note])
));
XLSX.utils.book_append_sheet(wb, ws2, 'Areas');

const meta = { profession: 'Coffee shop', areaCount: 2, doneCount: 2, failedCount: 0, emptyCount: 0,
  startedAt: 1750000000000, finishedAt: 1750004200000 };
const ws3 = XLSX.utils.aoa_to_sheet([
  ['Metric', 'Value'], ['Profession', meta.profession], ['Areas queued', 2], ['Areas completed', 2],
  ['Areas with no results', 0], ['Areas failed', 0], ['Unique businesses', merged.rows.length],
  ['Duplicate records removed', merged.duplicates]
]);
XLSX.utils.book_append_sheet(wb, ws3, 'Summary');

const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

/* === read it back === */
eq('workbook is a non-trivial binary', bytes.byteLength > 2000, true);
/* `type:'array'` yields an ArrayBuffer in this build, which Blob accepts */
eq('output is Blob-safe (ArrayBuffer or Uint8Array)',
  Object.prototype.toString.call(bytes), '[object ArrayBuffer]');
const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
eq('zip magic header', String.fromCharCode(u8[0], u8[1]), 'PK');
eq('zip local file header signature', u8[3] === 0x04, true);

const back = XLSX.read(bytes, { type: 'array' });
eq('3 sheets', back.SheetNames, ['Businesses', 'Areas', 'Summary']);

const b1 = XLSX.utils.sheet_to_json(back.Sheets.Businesses, { header: 1 });
eq('Businesses row count = header + 4 unique', b1.length, 5);
eq('header row', b1[0], head);
eq('column count', b1[0].length, 19);

const names = b1.slice(1).map((r) => r[1]);
eq('no duplicate Name cells', names, ['Blue Cafe', 'Red Gym', 'Green Salon', 'Yellow Deli']);
eq('5 raw hits collapsed to 4', merged.duplicates, 1);

const redGym = b1.slice(1).find((r) => r[1] === 'Red Gym');
eq('Red Gym Areas cell lists both areas', redGym[EXPORT_COLUMNS.findIndex((c) => c.key === 'areas')], 'Downtown | Midtown');
eq('Red Gym Area Count is numeric 2', redGym[EXPORT_COLUMNS.findIndex((c) => c.key === 'areaCount')], 2);
eq('Red Gym reviews survived from the richer hit', redGym[EXPORT_COLUMNS.findIndex((c) => c.key === 'reviews')], 90);
eq('Red Gym empty website is blank string', redGym[EXPORT_COLUMNS.findIndex((c) => c.key === 'website')], '');
eq('Blue Cafe rating is a real number 4.5', blue(b1, 'Blue Cafe', 'rating'), 4.5);
eq('Blue Cafe latitude is a real number', typeof blue(b1, 'Blue Cafe', 'latitude'), 'number');
eq('Green Salon missing rating is blank', greenRating(b1), '');

function blue(rows, nm, key) {
  const i = EXPORT_COLUMNS.findIndex((c) => c.key === key);
  return rows.slice(1).find((r) => r[1] === nm)[i];
}
function greenRating(rows) {
  return blue(rows, 'Green Salon', 'rating');
}

const b2 = XLSX.utils.sheet_to_json(back.Sheets.Areas, { header: 1 });
eq('Areas sheet header', b2[0], aHead);
eq('Areas sheet rows', b2.length, 3);
eq('Downtown unique=3', b2[1][3], 3);
eq('Midtown unique=2', b2[2][3], 2);
eq('Downtown seconds rounded from 41000ms', b2[1][7], 41);

const b3 = XLSX.utils.sheet_to_json(back.Sheets.Summary, { header: 1 });
eq('Summary profession', b3[1][1], 'Coffee shop');
eq('Summary unique count matches', b3[6][1], 4);
eq('Summary duplicate count matches', b3[7][1], 1);

/* --- CSV escaping check (popup.js exportCsv) --- */
const q = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
eq('comma-containing address is quoted', q('1 A St, Denver, CO'), '"1 A St, Denver, CO"');
eq('embedded quote is doubled', q('Joe "JJ" Cafe'), '"Joe ""JJ"" Cafe"');
eq('plain value is untouched', q('Blue Cafe'), 'Blue Cafe');
eq('null becomes empty', q(null), '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
