/* Maps Scraper Pro - de-duplication + row building.
 * Imported by both the service worker and the popup so there is exactly one
 * definition of "the same place".
 */

export const EXPORT_COLUMNS = [
  { key: 'row', header: '#', width: 6 },
  { key: 'name', header: 'Name', width: 34 },
  { key: 'category', header: 'Category', width: 22 },
  { key: 'rating', header: 'Rating', width: 8 },
  { key: 'reviews', header: 'Reviews', width: 10 },
  { key: 'price', header: 'Price', width: 8 },
  { key: 'openStatus', header: 'Open Status', width: 16 },
  { key: 'address', header: 'Address', width: 38 },
  { key: 'phone', header: 'Phone', width: 18 },
  { key: 'website', header: 'Website', width: 30 },
  { key: 'areas', header: 'Areas Found In', width: 30 },
  { key: 'areaCount', header: 'Area Count', width: 11 },
  { key: 'latitude', header: 'Latitude', width: 12 },
  { key: 'longitude', header: 'Longitude', width: 12 },
  { key: 'plusCode', header: 'Plus Code', width: 14 },
  { key: 'placeId', header: 'Place ID', width: 24 },
  { key: 'cid', header: 'CID', width: 14 },
  { key: 'mapsUrl', header: 'Google Maps URL', width: 40 },
  { key: 'chips', header: 'Attributes', width: 24 }
];

const normKey = (s) =>
  String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function dedupeKey(r) {
  if (r.placeId) return 'p:' + String(r.placeId).toLowerCase();
  if (r.cid) return 'c:' + r.cid;
  if (r.ftid) return 'f:' + r.ftid;
  return (
    'n:' +
    normKey(r.name) +
    '|' +
    normKey(r.address || '') +
    '|' +
    String(r.phone || '').replace(/\D/g, '')
  );
}

/**
 * @param {Array} areaRows  state.areas - one entry per area, in run order
 * @param {Object} areaData map of areaIndex -> array of records
 * @param {boolean} dedupe  when false, records are kept even if repeated
 */
export function mergeAreaData(areaRows, areaData, dedupe) {
  const byKey = new Map();
  const order = [];
  let duplicates = 0;

  (areaRows || []).forEach((a, i) => {
    const list = Array.isArray(areaData[i]) ? areaData[i] : [];
    for (const r of list) {
      if (!r || !r.name) continue;
      const key = dedupe === false ? `raw:${order.length}` : dedupeKey(r);
      const existing = byKey.get(key);
      if (existing) {
        duplicates++;
        existing.duplicates += 1;
        const areaName = r.area || a.name;
        if (areaName && existing.areas.indexOf(areaName) === -1) existing.areas.push(areaName);
        /* A repeat hit is usually sparser than the first one, but it can still
           carry a field we are missing (phone, website, coordinates, ...).
           Fill those gaps so nothing collected is thrown away. */
        for (const c of EXPORT_COLUMNS) {
          const k = c.key;
          if (k === 'row' || k === 'areas' || k === 'areaCount') continue;
          if ((existing[k] === '' || existing[k] == null) && r[k] != null && r[k] !== '') {
            existing[k] = r[k];
          }
        }
        continue;
      }
      const areaName = r.area || a.name;
      byKey.set(key, Object.assign({}, r, {
        areas: areaName ? [areaName] : [],
        duplicates: 0
      }));
      order.push(key);
    }
  });

  const rows = order.map((k, i) => {
    const e = byKey.get(k);
    const out = { row: i + 1 };
    for (const c of EXPORT_COLUMNS) {
      if (c.key === 'row') continue;
      if (c.key === 'areaCount') { out[c.key] = e.areas.length; continue; }
      if (c.key === 'areas') { out[c.key] = e.areas.join(' | '); continue; }
      out[c.key] = e[c.key] == null ? '' : e[c.key];
    }
    return out;
  });

  return { rows, duplicates, unique: rows.length };
}

export function areaSummary(areaRows, areaData) {
  return (areaRows || []).map((a, i) => {
    const list = Array.isArray(areaData[i]) ? areaData[i] : [];
    const seen = new Set();
    let withPhone = 0, withWebsite = 0, withRating = 0;
    for (const r of list) {
      if (!r || !r.name) continue;
      const k = dedupeKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      if (r.phone) withPhone++;
      if (r.website) withWebsite++;
      if (r.rating !== '' && r.rating != null) withRating++;
    }
    return {
      area: a.name,
      status: a.status,
      results: a.found != null ? a.found : list.length,
      unique: seen.size,
      withPhone,
      withWebsite,
      withRating,
      seconds: a.ms ? Math.round(a.ms / 1000) : 0,
      note: a.error || ''
    };
  });
}
