/* Sanity tests for the de-dup / export engine.  Run: node test/merge.test.mjs */
import { mergeAreaData, areaSummary, dedupeKey } from '../lib/merge.js';

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       expected ' + B + '\n       actual   ' + A); }
};

/* ---- key derivation ---- */
eq('key prefers placeId', dedupeKey({ placeId: '0xABC:0xDEF', name: 'X' }), 'p:0xabc:0xdef');
eq('key falls back to cid', dedupeKey({ cid: '99', name: 'X' }), 'c:99');
eq('key falls back to name+addr+phone',
  dedupeKey({ name: 'Joe\'s Diner', address: '12 Main St, Denver, CO', phone: '(303) 555-0101' }),
  dedupeKey({ name: "joes diner", address: '12  main  st  denver co', phone: '3035550101' }));

/* ---- cross-area de-dup, exactly like a real run ---- */
const areas = [
  { name: 'Downtown',   status: 'done',  found: 3, ms: 41000 },
  { name: 'Midtown',    status: 'done',  found: 2, ms: 38000 },
  { name: 'Riverside',  status: 'empty', found: 0, ms: 9000 },
  { name: 'Nowhere',    status: 'error', found: 0, ms: 5000, error: 'Blocked' }
];
const areaData = {
  0: [
    { name: 'Blue Cafe', category: 'Cafe', rating: 4.5, reviews: 210, address: '1 A St', phone: '', placeId: 'pA', area: 'Downtown' },

    { name: 'Red Gym',     category: 'Gym',  rating: 4,   reviews: 90,  address: '2 B St', phone: '555-0002', placeId: 'pB', area: 'Downtown' },
    { name: 'Green Salon', category: 'Salon',rating: '',  reviews: '',   address: '3 C St', phone: '',         placeId: 'pC', area: 'Downtown' }
  ],
  // 'Red Gym' repeats in Midtown with a sparser record (rating/reviews missing)
  1: [
    { name: 'Red Gym',     category: 'Gym',  rating: '',  reviews: '',   address: '2 B St', phone: '555-0002', placeId: 'pB', area: 'Midtown' },
    { name: 'Blue Cafe', category: '', rating: '', reviews: '', address: '1 A St', phone: '555-0001', website: 'https://blue.example', placeId: 'pA', area: 'Midtown' }

  ],
  2: [],
  3: []
};

const m = mergeAreaData(areas, areaData, true);
eq('5 raw records in', 5, areaData[0].length + areaData[1].length);
eq('3 unique rows out', m.rows.length, 3);
eq('2 duplicates removed', m.duplicates, 2);

const blue = m.rows.find((r) => r.name === 'Blue Cafe');
const red  = m.rows.find((r) => r.name === 'Red Gym');
eq('Blue Cafe keeps its rating',  blue.rating, 4.5);
eq('Blue Cafe records both areas', blue.areas, 'Downtown | Midtown');
eq('Red Gym keeps reviews from first hit', red.reviews, 90);
eq('Red Gym records both areas', red.areas, 'Downtown | Midtown');
eq('areaCount = 2', red.areaCount, 2);

/* Regression: the field back-fill loop used Object.keys() on an *array*, which
   yields index strings, so a repeat hit's missing fields were never merged in. */
eq('repeat hit back-fills a missing phone', blue.phone, '555-0001');
eq('repeat hit back-fills a missing website', blue.website, 'https://blue.example');
eq('back-fill never overwrites a good value', red.reviews, 90);
eq('back-fill never overwrites a good value (phone)', red.phone, '555-0002');
eq('back-fill leaves a still-empty field empty', m.rows.find((r) => r.name === 'Green Salon').website, '');
eq('rows carry no internal payload', Object.prototype.hasOwnProperty.call(m.rows[0], '_raw'), false);
eq('rows are numbered 1..n', m.rows.map((r) => r.row), [1, 2, 3]);
eq('empty fields serialise as empty string', m.rows.find((r) => r.name === 'Green Salon').website, '');

/* de-dup OFF must keep every record */
const raw = mergeAreaData(areas, areaData, false);
eq('de-dup off keeps all 5', raw.rows.length, 5);
eq('de-dup off reports 0 dupes', raw.duplicates, 0);

/* ---- per-area summary sheet ---- */
const sum = areaSummary(areas, areaData);
eq('summary row count', sum.length, 4);
eq('Downtown unique = 3', sum[0].unique, 3);
eq('Downtown with phone = 1', sum[0].withPhone, 1);
eq('Downtown with rating = 2', sum[0].withRating, 2);
eq('Midtown unique = 2', sum[1].unique, 2);
eq('Midtown with rating = 0 (sparse re-hits)', sum[1].withRating, 0);
eq('Riverside seconds rounded', sum[2].seconds, 9);
eq('Nowhere carries its error note', sum[3].note, 'Blocked');

/* ---- robustness: junk input must not throw ---- */
const junk = mergeAreaData(
  [{ name: 'A' }, null, { name: 'B' }],
  { 0: [null, {}, { name: 'Real' }], 1: 'not-an-array', 2: [undefined] },
  true
);
eq('junk input yields only the valid record', junk.rows.length, 1);
eq('junk record name preserved', junk.rows[0].name, 'Real');
eq('undefined area list is safe', mergeAreaData(undefined, undefined, true).rows.length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
