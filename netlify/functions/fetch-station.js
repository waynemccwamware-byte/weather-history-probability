// netlify/functions/fetch-station.js
//
// Server-side fetch + parse of NOAA GHCNh (the dataset that replaced ISD in
// Aug 2025). Runs on Netlify's Node runtime, so it isn't subject to browser
// CORS restrictions or the robots.txt rule that blocks direct browser/tool
// access to some NCEI paths.

const tzlookup = require('./tzlookup');
//
// Query params:
//   station   - an 11-char GHCN station id (e.g. USW00023234), if you already
//               know it. Skips the station-list lookup.
//   icao      - an ICAO/FAA identifier or station name to look up instead
//               (e.g. KHAF, "Half Moon Bay"). Slower (fetches + scans the
//               ~ station list file once).
//
// Returns (resolve): { candidates: [...], nearby: [...], maxMatchKm }
//   candidates = stations within MAX_MATCH_DISTANCE_KM, nearest first;
//   when empty, nearby = the closest few stations (within NEARBY_RADIUS_KM).
//   Both lists hold only stations with a file for the requested years
//   (?startYear=&endYear=), checked with a HEAD request (v0.6).
//   so the page can offer them as proxies. GHCNh is worldwide, so this
//   works the same for US, Mexican and Canadian airports (v0.5).
// Returns (year fetch): { station, year, timeZone, ok, count, rows: [...] }
//
// NOTE: column names below are inferred from NOAA's public documentation
// (sky_cover_1/2/3, sky_cov_baseht_1/2/3, visibility) but not verified
// against a live file from this environment. The parser locates columns by
// name rather than position specifically so small naming differences don't
// silently break it -- but the very first real run should be sanity-checked
// against known numbers (e.g. compare KHAF against the CSV-based analysis
// already done for that station).

const STATION_LIST_URL =
  'https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/doc/ghcnh-station-list.csv';

function porUrl(stationId) {
  return `https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/access/by-station/GHCNh_${stationId}_por.psv`;
}

function byYearUrl(stationId, year) {
  return `https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/access/by-year/${year}/psv/GHCNh_${stationId}_${year}.psv`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Coordinate-based lookup: finds the GHCNh station physically nearest to a
// known lat/lon, rather than text-matching a name/ICAO against the global
// station list. This sidesteps a real failure mode we hit in testing: an
// ICAO-style query like "KUKI" can coincidentally match an unrelated
// station's *name* field elsewhere in the world (a town in Japan is also
// named Kuki), producing a confident but wrong match. Distance can't be
// coincidentally wrong in that way.
const MAX_MATCH_DISTANCE_KM = 15;

// Best-effort station name from a station-list line. Only columns 0-2
// (id, lat, lon) are relied on elsewhere; the rest of the line's layout
// isn't verified here, so this just takes the first field after the
// coordinates/elevation that contains letters. Display-only -- never used
// for matching.
function stationNameFromLine(line) {
  const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
  for (let i = 3; i < parts.length; i++) {
    if (/[A-Za-z]{3,}/.test(parts[i])) return parts[i];
  }
  return '';
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Nearby-station search radius when nothing is within MAX_MATCH_DISTANCE_KM
// (e.g. a Baja dirt strip): the caller gets the closest few stations so
// the user can pick one as a proxy.
const NEARBY_RADIUS_KM = 250;
const NEARBY_LIMIT = 12;      // page narrows these to ones at ICAO airports
const CHECK_POOL = 40;        // how many nearest station IDs get an existence check
const CHECK_TIMEOUT_MS = 3000;

// NOAA's station list carries many retired / re-registered IDs at the same
// site, often closer than the live one (seen in v0.5 at MMLP and CYYZ).
// So before offering a station, check that its by-year file exists for the
// requested years. Only a 404 counts as "no data"; a timeout or any other
// status counts as unknown and the station is kept, so a slow NOAA server
// never empties the list.
async function yearFileStatus(id, year) {
  try {
    const res = await fetchWithTimeout(byYearUrl(id, year), CHECK_TIMEOUT_MS, { method: 'HEAD' });
    if (res.ok) return 'yes';
    if (res.status === 404) return 'no';
    return 'unknown';
  } catch (err) {
    return 'unknown';
  }
}
async function hasDataFor(id, years) {
  for (const y of years) {
    const st = await yearFileStatus(id, y);
    if (st !== 'no') return true; // 'yes', or unknown -> keep
  }
  return false; // every year checked came back 404
}

async function resolveStationCandidatesByCoords(lat, lon, limit, checkYears) {
  const res = await fetchWithTimeout(STATION_LIST_URL, 7000);
  if (!res.ok) throw new Error(`Could not fetch station list (HTTP ${res.status})`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);

  const all = [];
  const deg = NEARBY_RADIUS_KM / 111 + 0.5; // generous lat/lon pre-filter box
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const id = parts[0];
    const slat = parseFloat(parts[1]);
    const slon = parseFloat(parts[2]);
    if (!id || isNaN(slat) || isNaN(slon)) continue;
    // Cheap pre-filter before the trig-heavy haversine call.
    if (Math.abs(slat - lat) > deg || Math.abs(slon - lon) > deg * 2) continue;
    const dist = haversineKm(lat, lon, slat, slon);
    if (dist <= NEARBY_RADIUS_KM) {
      all.push({ id, matchedLine: line.trim(), name: stationNameFromLine(line), distanceKm: dist,
        bearing: bearingDeg(lat, lon, slat, slon), lat: slat, lon: slon });
    }
  }
  all.sort((a, b) => a.distanceKm - b.distanceKm);

  // Existence check on the nearest CHECK_POOL IDs, in parallel.
  const pool = all.slice(0, CHECK_POOL);
  let checked = 0;
  if (checkYears && checkYears.length) {
    const flags = await Promise.all(pool.map(s => hasDataFor(s.id, checkYears)));
    pool.forEach((s, i) => { s.active = flags[i]; });
    checked = pool.length;
  } else {
    pool.forEach(s => { s.active = true; });
  }
  const active = pool.filter(s => s.active);

  const candidates = active.filter(s => s.distanceKm <= MAX_MATCH_DISTANCE_KM)
    .slice(0, limit)
    .map(({ id, matchedLine, distanceKm, lat, lon }) => ({ id, matchedLine, distanceKm, lat, lon }));

  // Several station IDs often share one site; keep only the nearest
  // active ID per ~1 km spot so the proxy list shows distinct places.
  const nearby = [];
  for (const n of active) {
    if (nearby.some(d => haversineKm(d.lat, d.lon, n.lat, n.lon) < 1)) continue;
    nearby.push({ id: n.id, name: n.name, distanceKm: n.distanceKm, bearing: n.bearing, lat: n.lat, lon: n.lon });
    if (nearby.length >= NEARBY_LIMIT) break;
  }
  return { candidates, nearby, checked, inactive: pool.length - active.length };
}

async function resolveStationId(icaoOrName) {
  const res = await fetchWithTimeout(STATION_LIST_URL, 7000);
  if (!res.ok) throw new Error(`Could not fetch station list (HTTP ${res.status})`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const q = icaoOrName.trim().toUpperCase();

  // Station list format varies by source vintage, so we scan text rather than
  // fixed columns. Two passes, strongest match first:
  //   1. q appears as a standalone word (bounded by non-alphanumerics) —
  //      this is what an ICAO code like "KHAF" should hit.
  //   2. q appears anywhere in the line — loose fallback, only used if pass 1
  //      finds nothing, and only for queries of 4+ chars to reduce noise.
  const wordBoundaryRe = new RegExp(`(^|[^A-Z0-9])${q}([^A-Z0-9]|$)`);

  const extractId = (line) =>
    (line.match(/^([A-Z0-9]{11})/) || line.match(/\b([A-Z]{2}[A-Z0-9]{9})\b/) || [])[1];
  const extractLatLon = (line) => {
    const parts = line.split(',');
    const slat = parseFloat(parts[1]);
    const slon = parseFloat(parts[2]);
    return (isNaN(slat) || isNaN(slon)) ? { lat: null, lon: null } : { lat: slat, lon: slon };
  };

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (wordBoundaryRe.test(upper)) {
      const id = extractId(line);
      if (id) return { id, matchedLine: line.trim(), ...extractLatLon(line) };
    }
  }

  if (q.length >= 4) {
    for (const line of lines) {
      if (line.toUpperCase().includes(q)) {
        const id = extractId(line);
        if (id) return { id, matchedLine: line.trim(), ...extractLatLon(line) };
      }
    }
  }
  throw new Error(`No GHCNh station found matching "${icaoOrName}". Try passing the 11-char GHCN station id directly.`);
}

function parsePsvLine(line, delim) {
  return line.split(delim).map(s => s.trim());
}

function findCol(header, ...needles) {
  const lower = header.map(h => h.toLowerCase());
  // Exact match first — several real GHCNh columns (precipitation_3_hour,
  // precipitation_6_hour, etc.) contain "hour" as a substring, which would
  // otherwise shadow the actual "Hour" column if we only did substring
  // matching.
  for (const needle of needles) {
    const exact = lower.findIndex(h => h === needle);
    if (exact !== -1) return exact;
  }
  for (const needle of needles) {
    const idx = lower.findIndex(h => h.includes(needle));
    if (idx !== -1) return idx;
  }
  return -1;
}

// sky_condition (and each sky_cover_layer_N) is a NOAA numeric coverage
// code, not a text abbreviation — confirmed against NOAA's own
// documentation (sky_condition data field: "total;opaque;lowest", each a
// 2-digit code). We use the "total" code (the field before the first
// semicolon, when present).
//
// Coverage code key (per NOAA):
//   00 None/SKC/CLR       05 Five oktas          10 Partial obscuration
//   01 One okta           06 Six oktas           11 Thin scattered
//   02 Two oktas/FEW      07 Seven oktas/BKN     12 Scattered
//   03 Three oktas        08 Eight oktas/OVC     13 Dark scattered
//   04 Four oktas/SCT     09 Sky obscured        14 Thin broken
//                                                 15 Broken
//                                                 16 Dark broken
//                                                 17 Thin overcast
//                                                 18 Overcast
//                                                 19 Dark overcast
// CLR/FEW/SCT-equivalent (no ceiling): 00-06, 11-13.
// BKN/OVC/obscured-equivalent (ceiling exists): 07-10, 14-19.
function isClearCode(code) {
  return code <= 6 || code === 11 || code === 12 || code === 13;
}

// sky_condition's data field is "total;opaque;lowest" — up to 3 semicolon-
// separated 2-digit codes. Automated (AWOS-type) stations don't always
// populate 'total' meaningfully, so rather than trust just the first
// sub-field, parse all three present codes and treat the hour as "not
// clear" if ANY of them indicates a ceiling. Returns an array of valid
// numeric codes found (may be empty if the field is blank/unparseable).
function skyConditionCodes(raw) {
  if (raw === undefined || raw === null) return [];
  const s = raw.trim();
  if (s === '') return [];
  return s.split(';')
    .map(part => parseInt(part.trim(), 10))
    .filter(code => !isNaN(code) && code >= 0 && code <= 19); // NOAA's documented range; anything else (e.g. a 99 missing-value sentinel) isn't a real coverage code
}

// sky_cover_summation_1..4: verified directly against real GHCNh data
// (df[col].unique()) to contain clean text categories — CLR, FEW, SCT,
// BKN, OVC, VV — rather than numeric codes. This is a more reliable
// primary source than the numeric sky_condition/sky_cover_layer fields.
function isClearText(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (s === '') return null;
  const cat = s.split(':')[0].trim().toUpperCase(); // some sources format as "CLR:00"
  if (cat === '') return null;
  if (cat === 'BKN' || cat === 'OVC' || cat === 'VV') return false;
  if (cat === 'CLR' || cat === 'FEW' || cat === 'SCT') return true;
  return null; // unrecognized token — don't guess
}

// Present-weather intensity classification for the "precipitation: none or
// light" metric. Same nine pres_wx_* fields already used for the
// convective-storm metric, and the same "blank = nothing to report"
// convention (per NOAA's present-weather documentation) -- so a row with
// no matching field is favorable (no precip reported), not excluded.
//
// AU (automated ASOS/AWOS -- the dominant source for US airports) carries
// literal METAR weather-group text per ghcnh-present-weather-elements.pdf
// Table 5(c)'s own intensity sub-codes (1 = "-" light, 3 = "+" heavy, no
// prefix = moderate) -- so this parses the standard METAR "-RA"/"RA"/"+RA"
// convention directly. "VC" (in the vicinity, not at the station) doesn't
// count as occurring here.
const PRECIP_TYPE_RE = /(RA|DZ|SN|SG|IC|PL|GR|GS|UP)/;
function auPrecipSeverity(raw) {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  if (v.includes('VC')) return null; // in the vicinity, not at the station
  if (!PRECIP_TYPE_RE.test(v)) return null; // no precip type in this field
  if (v.startsWith('-')) return 'light';
  if (v.startsWith('+')) return 'moderate-or-heavier';
  return 'moderate-or-heavier'; // no prefix = moderate, per standard METAR convention
}

// MW (manually-augmented stations) codes: flat numeric 00-99, with
// intensity baked directly into which specific code is used -- per
// ghcnh-present-weather-elements.pdf Table 5(a). Codes 20-29 describe the
// *preceding* hour rather than current conditions, so they're excluded
// here (same reasoning as blank: not a report of precip happening now).
// Codes 91-99 (thunderstorm combinations) are all treated as
// moderate-or-heavier, since even the "slight" variants (91, 93) co-occur
// with a thunderstorm the convective metric already flags separately.
const MW_LIGHT = new Set([50, 51, 56, 58, 60, 61, 66, 68, 70, 71, 76, 77, 78, 79, 80, 83, 85, 87, 89, 91, 93]);
const MW_MOD_PLUS = new Set([52, 53, 54, 55, 57, 59, 62, 63, 64, 65, 67, 69, 72, 73, 74, 75, 81, 82, 84, 86, 88, 90, 92, 94, 95, 96, 97, 98, 99]);
function mwPrecipSeverity(raw) {
  if (!raw) return null;
  const code = parseInt(raw.trim(), 10);
  if (isNaN(code)) return null;
  if (MW_LIGHT.has(code)) return 'light';
  if (MW_MOD_PLUS.has(code)) return 'moderate-or-heavier';
  return null; // not a precip code at all (dust, fog, blowing snow, etc.)
}

// AW (other automated sources) codes: same numeric-code shape as MW but a
// different table (5b), and several of its codes bundle "slight-or-
// moderate" into one code with no way to separate them -- those are
// treated conservatively as moderate-or-heavier rather than assumed light.
const AW_LIGHT = new Set([51, 54, 57, 61, 64, 67, 71, 74, 77, 78, 81, 85]);
const AW_MOD_PLUS = new Set([40, 41, 42, 43, 44, 45, 46, 47, 48, 52, 53, 55, 56, 58, 62, 63, 65, 66, 68, 72, 73, 75, 76, 80, 82, 83, 84, 86, 87, 89, 90, 91, 92, 93, 94, 95, 96]);
function awPrecipSeverity(raw) {
  if (!raw) return null;
  const code = parseInt(raw.trim(), 10);
  if (isNaN(code)) return null;
  if (AW_LIGHT.has(code)) return 'light';
  if (AW_MOD_PLUS.has(code)) return 'moderate-or-heavier';
  return null;
}

function presWxPrecipSeverity(group, raw) {
  if (group === 'au') return auPrecipSeverity(raw);
  if (group === 'mw') return mwPrecipSeverity(raw);
  if (group === 'aw') return awPrecipSeverity(raw);
  return null;
}

function parseYearFile(text, timeZone) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { rows: [], header: [] };

  const delim = lines[0].includes('|') ? '|' : ',';
  const header = parsePsvLine(lines[0], delim);

  const idxYear = findCol(header, 'year');
  const idxMonth = findCol(header, 'month');
  const idxDay = findCol(header, 'day');
  const idxHour = findCol(header, 'hour');
  // One observation per UTC hour. v0.5 kept only FM15 (routine METAR),
  // which silently dropped stations whose GHCNh source is SYNOP (FM12) or
  // a national network (e.g. Canadian CAN* and Mexican MXM* IDs) -- seen
  // live as "0 obs" at MXM00076404 and 52 obs in 5 years at CAN01108395.
  // Now: drop SPECI (FM16, unscheduled -- would over-weight bad-weather
  // hours), then keep one report per hour, preferring FM15, then FM12,
  // then whatever else is there. Matches v0.4 results at METAR stations,
  // since an FM15 always wins its hour.
  const idxReportType = findCol(header, 'temperature_report_type');
  const typePriority = (t) => (t === 'FM15' ? 0 : t === 'FM12' ? 1 : 2);
  // sky_cover_summation_1..4 (text CLR/FEW/SCT/BKN/OVC/VV) is the primary
  // source — confirmed against real data in prior analysis. sky_condition
  // (numeric total;opaque;lowest codes) and sky_cover_layer_1..4 are
  // fallbacks for files where summation isn't present.
  const idxSkySummation = [
    findCol(header, 'sky_cover_summation_1'),
    findCol(header, 'sky_cover_summation_2'),
    findCol(header, 'sky_cover_summation_3'),
    findCol(header, 'sky_cover_summation_4'),
  ].filter(i => i !== -1);
  const idxSkyCondition = findCol(header, 'sky_condition');
  const idxSkyLayers = [
    findCol(header, 'sky_cover_layer_1'),
    findCol(header, 'sky_cover_layer_2'),
    findCol(header, 'sky_cover_layer_3'),
    findCol(header, 'sky_cover_layer_4'),
  ].filter(i => i !== -1);
  // ceiling_height / visibility support the VFR and fog/visibility
  // metrics. Confirmed via NOAA's own GHCNh documentation (PDF): raw
  // ceiling_height is in meters, raw visibility is in kilometers -- both
  // converted below to the feet/statute-miles thresholds these metrics use.
  const idxCeiling = findCol(header, 'ceiling_height');
  const idxVisibility = findCol(header, 'visibility');
  // Present-weather fields for the convective-storm metric. Confirmed via
  // NOAA's ghcnh-present-weather-elements.pdf: across all three source
  // tables (manual MW, automated AW, automated ASOS/AWOS AU), a
  // thunderstorm is consistently flagged with a literal "TS" prefix/
  // descriptor, and a tornado/funnel cloud with "FC" -- a simple substring
  // check across all nine fields catches this regardless of which table a
  // given station's source uses. Per the same doc, these fields are
  // typically left blank when there's nothing notable to report (standard
  // METAR/present-weather omission convention) -- so blank is treated as
  // "no storm reported", not "missing data".
  const idxPresWx = [
    findCol(header, 'pres_wx_mw1'), findCol(header, 'pres_wx_mw2'), findCol(header, 'pres_wx_mw3'),
    findCol(header, 'pres_wx_aw1'), findCol(header, 'pres_wx_aw2'), findCol(header, 'pres_wx_aw3'),
    findCol(header, 'pres_wx_au1'), findCol(header, 'pres_wx_au2'), findCol(header, 'pres_wx_au3'),
  ].filter(i => i !== -1);
  // Same nine fields, but grouped by source table so the precipitation
  // metric can apply the right severity rules to each -- MW/AW use flat
  // numeric codes (a different 00-99 scheme per table), AU (the dominant
  // source for US ASOS/AWOS airports) uses literal METAR weather-group
  // text (e.g. "-RA", "+TSRA") per ghcnh-present-weather-elements.pdf.
  const idxPresWxByGroup = [
    { idx: findCol(header, 'pres_wx_mw1'), group: 'mw' },
    { idx: findCol(header, 'pres_wx_mw2'), group: 'mw' },
    { idx: findCol(header, 'pres_wx_mw3'), group: 'mw' },
    { idx: findCol(header, 'pres_wx_aw1'), group: 'aw' },
    { idx: findCol(header, 'pres_wx_aw2'), group: 'aw' },
    { idx: findCol(header, 'pres_wx_aw3'), group: 'aw' },
    { idx: findCol(header, 'pres_wx_au1'), group: 'au' },
    { idx: findCol(header, 'pres_wx_au2'), group: 'au' },
    { idx: findCol(header, 'pres_wx_au3'), group: 'au' },
  ].filter(e => e.idx !== -1);
  // Wind fields for the surface-wind metric. Confirmed via NOAA's
  // ghcnh_DOCUMENTATION.pdf: both wind_speed and wind_gust are in meters
  // per second.
  const idxWindSpeed = findCol(header, 'wind_speed');
  const idxWindGust = findCol(header, 'wind_gust');
  // v0.10 span hover: hourly liquid precipitation (mm, past hour) and dew
  // point (deg C). Exact column names only -- a substring match on
  // "precipitation" would land on precipitation_3_hour or a
  // *_Quality_Code / *_Measurement_Code companion column.
  const findExact = (name) => header.findIndex(h => h.toLowerCase() === name);
  const idxPrecip = findExact('precipitation');
  const idxDewPoint = findExact('dew_point_temperature');
  // v0.17 temperature / density altitude. Per the GHCNh variable list
  // (temperature = air temperature at 2 m, deg C; station_level_pressure and
  // altimeter in hPa). Density altitude uses station pressure when the hour
  // has it; otherwise the altimeter setting reduced to the station's
  // elevation (only if the file carries an Elevation column, in meters).
  const idxTemp = findExact('temperature');
  const idxStnPres = findExact('station_level_pressure');
  const idxAltimeter = findExact('altimeter');
  const idxElev = findExact('elevation');
  const daSourceCounts = { station: 0, altimeter: 0, none: 0 };

  if (idxYear === -1 || idxMonth === -1 || idxDay === -1 || idxHour === -1) {
    return { rows: [], header, columnsMissing: true };
  }

  const rows = [];
  const hourSlot = new Map(); // 'y-m-d-h' (UTC) -> { idx in rows, pri }
  const reportTypeCounts = {};
  const samplePresWx = [];
  const convectiveSamples = [];
  let totalPresWxNonEmpty = 0;
  let skippedNoSkyData = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = parsePsvLine(lines[i], delim);
    const y = parseInt(cols[idxYear], 10);
    const mo = parseInt(cols[idxMonth], 10);
    const d = parseInt(cols[idxDay], 10);
    const h = parseInt(cols[idxHour], 10);
    if (!y || !mo || !d || isNaN(h)) continue;
    const rType = idxReportType !== -1 && cols[idxReportType] ? cols[idxReportType].trim() : '';
    reportTypeCounts[rType || '(blank)'] = (reportTypeCounts[rType || '(blank)'] || 0) + 1;
    if (rType === 'FM16') continue; // SPECI
    const slotKey = `${y}-${mo}-${d}-${h}`;

    const local = toLocalParts(y, mo, d, h, timeZone);

    let clear = null;
    if (idxSkySummation.length > 0) {
      const results = idxSkySummation.map(idx => isClearText(cols[idx])).filter(r => r !== null);
      if (results.length > 0) clear = results.every(Boolean);
    }
    if (clear === null) {
      let codes = [];
      if (idxSkyCondition !== -1) codes = codes.concat(skyConditionCodes(cols[idxSkyCondition]));
      for (const idx of idxSkyLayers) codes = codes.concat(skyConditionCodes(cols[idx]));
      if (codes.length > 0) clear = codes.every(isClearCode);
    }
    // v0.8: an hour with no sky data is KEPT with clear = null, not
    // dropped. Some sources (e.g. Canada's national-network CAN* records,
    // seen live at CYYZ) carry visibility, wind and present weather but no
    // cloud cover at all; dropping those hours left nothing. The page
    // excludes null per metric, so low-cloud / VFR simply have no sample
    // while fog, storms, precip and wind still work. A report WITH sky data
    // beats one without for the same hour.
    const pri = typePriority(rType) + (clear === null ? 10 : 0);
    const prev = hourSlot.get(slotKey);
    if (prev && prev.pri <= pri) continue; // already have an equal-or-better report for this hour

    // Confirmed against NOAA's own GHCNh documentation: ceiling_height is
    // in meters ("Unlimited ceiling is 22000 meters") and visibility is in
    // kilometers ("horizontal distance... (kilometers)") -- both need
    // conversion to the feet/statute-miles thresholds used below.
    const ceilingRawM = idxCeiling !== -1 ? parseNumericOrNull(cols[idxCeiling]) : null;
    const visibilityRawKm = idxVisibility !== -1 ? parseNumericOrNull(cols[idxVisibility]) : null;
    const ceilingFt = ceilingRawM !== null ? ceilingRawM * 3.28084 : null;
    const visibilitySM = visibilityRawKm !== null ? visibilityRawKm * 0.621371 : null;

    let convectiveMatch = null;
    let presWxNonEmptyCount = 0;
    for (const idx of idxPresWx) {
      const v = cols[idx];
      if (!v) continue;
      presWxNonEmptyCount++;
      const u = v.toUpperCase();
      if (!convectiveMatch && (u.includes('TS') || u.includes('FC'))) convectiveMatch = v;
    }
    const noConvective = !convectiveMatch;
    totalPresWxNonEmpty += presWxNonEmptyCount;

    if (samplePresWx.length < 15) {
      for (const idx of idxPresWx) {
        if (cols[idx] && samplePresWx.length < 15) samplePresWx.push(cols[idx]);
      }
    }
    if (convectiveMatch && convectiveSamples.length < 10) convectiveSamples.push(convectiveMatch);

    // Precipitation: none-or-light metric. Defaults to favorable (blank
    // fields = nothing reported = no precip), flipped to unfavorable the
    // moment any field indicates moderate-or-heavier -- never excluded,
    // same pattern as noConvective above.
    let noModPrecip = true;
    for (const { idx, group } of idxPresWxByGroup) {
      if (presWxPrecipSeverity(group, cols[idx]) === 'moderate-or-heavier') {
        noModPrecip = false;
        break;
      }
    }

    // Surface-wind metric: effective wind = wind_speed + half of the
    // *gust factor* (how much wind_gust exceeds wind_speed) -- this
    // simplifies algebraically to (wind_speed + wind_gust) / 2, i.e. the
    // straight average of the two, converted from m/s to knots.
    // Favorable under 20 kt. A blank gust means no significant gust was
    // reported (same "blank = nothing notable" convention used
    // elsewhere), so the gust-factor term is 0 and effective wind just
    // falls back to wind_speed alone -- not excluded. A blank wind_speed,
    // though, genuinely means we don't know the wind, so that hour is
    // excluded (null), not guessed at.
    const windSpeedMs = idxWindSpeed !== -1 ? parseNumericOrNull(cols[idxWindSpeed]) : null;
    const windGustMs = idxWindGust !== -1 ? parseNumericOrNull(cols[idxWindGust]) : null;
    let windFavorable = null;
    let windKt = null;
    if (windSpeedMs !== null) {
      const gustFactorMs = windGustMs !== null ? Math.max(0, windGustMs - windSpeedMs) : 0;
      const effectiveMs = windSpeedMs + gustFactorMs / 2;
      const effectiveKt = effectiveMs * 1.943844;
      windFavorable = effectiveKt < 20;
      windKt = Math.round(effectiveKt * 10) / 10;
    }

    // v0.10 span hover values. Blank precipitation stays null (the page
    // treats null as "no measurable precip" only when the station reports
    // the field at all); mm -> inches, C -> F.
    const precipMm = idxPrecip !== -1 ? parseNumericOrNull(cols[idxPrecip]) : null;
    const precipIn = precipMm !== null && precipMm >= 0 ? Math.round(precipMm / 25.4 * 100) / 100 : null;
    const dewC = idxDewPoint !== -1 ? parseNumericOrNull(cols[idxDewPoint]) : null;
    const dewPointF = dewC !== null ? Math.round(dewC * 9 / 5 + 32) : null;
    const tempRaw = idxTemp !== -1 ? parseNumericOrNull(cols[idxTemp]) : null;
    const tempC = tempRaw !== null && tempRaw > -80 && tempRaw < 65 ? tempRaw : null;
    let stnHpa = idxStnPres !== -1 ? parseNumericOrNull(cols[idxStnPres]) : null;
    if (stnHpa !== null && (stnHpa < 500 || stnHpa > 1100)) stnHpa = null;
    let daSrc = stnHpa !== null ? 'station' : 'none';
    if (stnHpa === null && idxAltimeter !== -1 && idxElev !== -1) {
      const alt = parseNumericOrNull(cols[idxAltimeter]);
      const elevM = parseNumericOrNull(cols[idxElev]);
      if (alt !== null && alt > 850 && alt < 1100 && elevM !== null && elevM > -500 && elevM < 5500) {
        // Standard-atmosphere reduction of the altimeter setting to field level.
        stnHpa = alt * Math.pow(1 - 0.0065 * elevM / 288.15, 5.25588);
        daSrc = 'altimeter';
      }
    }
    const daFt = tempC !== null && stnHpa !== null ? densityAltitudeFt(stnHpa, tempC) : null;
    daSourceCounts[daFt !== null ? daSrc : 'none']++;

    // Rounded to keep the JSON payload small (thresholds are unaffected:
    // 1 ft and 0.01 SM are far finer than the 3000/4000 ft and 3/5 SM tests).
    const row = { year: local.year, month: local.month, day: local.day, hour: local.hour, clear,
      ceilingFt: ceilingFt !== null ? Math.round(ceilingFt) : null,
      visibilitySM: visibilitySM !== null ? Math.round(visibilitySM * 100) / 100 : null,
      noConvective, noModPrecip, windFavorable, windKt, precipIn, dewPointF,
      tempC: tempC !== null ? Math.round(tempC * 10) / 10 : null,
      dewC: dewC !== null ? Math.round(dewC * 10) / 10 : null,
      daFt };
    if (prev) {
      rows[prev.idx] = row; // a better report for an hour we already had
      prev.pri = pri;
    } else {
      hourSlot.set(slotKey, { idx: rows.length, pri });
      rows.push(row);
    }
  }
  skippedNoSkyData = rows.filter(r => r.clear === null).length; // hours kept but with no sky data
  return { rows, header, skippedNoSkyData, samplePresWx, convectiveSamples, totalPresWxNonEmpty, reportTypeCounts, daSourceCounts };
}

// Density altitude (ft) from station pressure (hPa) and temperature (deg C),
// dry air -- the NWS density-altitude formula with P in inHg and T in deg F:
// DA = 145442.16 * (1 - (17.326 * P / (459.67 + T)) ^ 0.235).
// Dry air matches E6B / POH-chart practice (pressure altitude + OAT); humid
// air would come out somewhat higher. Rounded to 10 ft.
function densityAltitudeFt(stnHpa, tempC) {
  const pInHg = stnHpa * 0.0295300;
  const tF = tempC * 9 / 5 + 32;
  const da = 145442.16 * (1 - Math.pow((17.326 * pInHg) / (459.67 + tF), 0.235));
  return Math.round(da / 10) * 10;
}

function parseNumericOrNull(raw) {
  if (raw === undefined || raw === null) return null;
  const s = raw.trim();
  if (s === '') return null;
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

// Fixed UTC-8 "local standard time" -> actual Pacific wall-clock date,
// honoring DST. Matches the convention used by the LCD/ISD-era data this
// app was originally built against; GHCNh/LCDv2 documentation states times
// are local standard time with no DST adjustment, so the same conversion
// applies here.
// GHCNh's raw Year/Month/Day/Hour is recorded in UTC (confirmed against
// third-party GHCNh tooling documentation, and consistent with the fact
// that raw METAR/synoptic reports are always Zulu-timestamped) -- no LST
// offset is added, the raw hour IS the UTC hour already. We then convert
// that instant into the *actual local timezone of the station* (via
// tzlookup on its coordinates) rather than assuming Pacific time, since
// the airport list now covers the whole US.
const formatterCache = new Map();
function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    }));
  }
  return formatterCache.get(timeZone);
}
function toLocalParts(year, month, day, hour, timeZone) {
  const utcMillis = Date.UTC(year, month - 1, day, hour, 0, 0);
  const dt = new Date(utcMillis);
  const parts = getFormatter(timeZone).formatToParts(dt);
  const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') };
}

// NCEI's servers can be slow. Netlify kills the whole function with a bare,
// bodiless 502 if it runs past the platform timeout -- which looks identical
// whether the cause was one hung request or genuine overall slowness. A
// per-request timeout turns "the function vanished" into an actual error
// message we can act on.
async function fetchWithTimeout(url, ms, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  try {
    const params = event.queryStringParameters || {};

    // ---- Mode 1: resolve only (no data fetch) ----
    // Returns just the station id, so the caller can then make N small,
    // independent single-year requests (mode 2) in parallel from the
    // browser, instead of one function invocation trying to fetch every
    // year itself and risking the platform's execution timeout.
    if (params.action === 'resolve') {
      let candidates;
      let nearby;
      const lat = parseFloat(params.lat);
      const lon = parseFloat(params.lon);
      if (params.station) {
        // A specific station (e.g. a proxy picked from the nearby list).
        // Pass its coordinates through so the year fetch gets the right
        // local time zone.
        candidates = [{ id: params.station, matchedLine: null, distanceKm: null,
          lat: isNaN(lat) ? null : lat, lon: isNaN(lon) ? null : lon }];
      } else {
        if (!isNaN(lat) && !isNaN(lon)) {
          // Multiple station IDs can share near-identical coordinates in
          // this dataset (e.g. a station replaced/re-registered over the
          // years) -- the physically nearest one isn't always the one with
          // actual GHCNh coverage, so return several ranked candidates
          // rather than committing to just the closest. If none is within
          // MAX_MATCH_DISTANCE_KM, candidates is empty and `nearby` lists
          // the closest stations for the user to pick from.
          // checkYears: the end and start years of the requested range
          // (end first) -- a station counts as live if either has a file.
          const ys = [parseInt(params.endYear, 10), parseInt(params.startYear, 10)]
            .filter((y, i, arr) => !isNaN(y) && arr.indexOf(y) === i);
          ({ candidates, nearby } = await resolveStationCandidatesByCoords(lat, lon, 5, ys));
        } else if (params.icao) {
          const resolved = await resolveStationId(params.icao);
          candidates = [{ id: resolved.id, matchedLine: resolved.matchedLine, distanceKm: null, lat: resolved.lat, lon: resolved.lon }];
        } else {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Pass ?station=<GHCN id>, or ?lat=&lon=, or ?icao=<code or name>' }) };
        }
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ candidates, nearby: nearby || [], maxMatchKm: MAX_MATCH_DISTANCE_KM })
      };
    }

    // ---- Mode 2: fetch one year for an already-resolved station ----
    const stationId = params.station;
    const year = parseInt(params.year, 10);
    if (!stationId || !year) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Pass ?station=<GHCN id>&year=<YYYY> (call ?action=resolve first to get the station id)' }) };
    }

    let timeZone = 'America/Los_Angeles'; // fallback if coordinates aren't available
    const tzLat = parseFloat(params.lat);
    const tzLon = parseFloat(params.lon);
    if (!isNaN(tzLat) && !isNaN(tzLon)) {
      try {
        timeZone = tzlookup(tzLat, tzLon);
      } catch (err) {
        // invalid coordinates -- keep the Pacific fallback rather than fail the whole request
      }
    }

    const res = await fetchWithTimeout(byYearUrl(stationId, year), 8000);
    if (!res.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ station: stationId, year, ok: false, status: res.status, rows: [] }) };
    }
    const text = await res.text();
    const parsed = parseYearFile(text, timeZone);
    if (parsed.columnsMissing) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Could not locate year/month/day/hour columns in GHCNh file — column names may have changed. Header was: ' + parsed.header.join(', ') })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ station: stationId, year, timeZone, ok: true, count: parsed.rows.length, skippedNoSkyData: parsed.skippedNoSkyData, reportTypeCounts: parsed.reportTypeCounts, samplePresWx: parsed.samplePresWx, convectiveSamples: parsed.convectiveSamples, totalPresWxNonEmpty: parsed.totalPresWxNonEmpty, daSourceCounts: parsed.daSourceCounts, rows: parsed.rows })
    };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'Request to NOAA timed out' : err.message;
    return { statusCode: 500, headers, body: JSON.stringify({ error: reason }) };
  }
};
