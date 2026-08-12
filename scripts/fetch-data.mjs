/**
 * Build-time data fetcher for the Core CPI ex-shelter site.
 *
 * Source policy (decided by probing both APIs):
 *   - BLS is PRIMARY for every CPI series. It is the original publisher; FRED mirrors it.
 *   - FRED is FALLBACK for headline / core / shelter only.
 *     FRED does NOT carry "CPI less food, shelter, and energy" at all
 *     (CUUR0000SA0L12E -> "series does not exist"), so the headline metric of this
 *     site has exactly one source. If BLS fails for it, we fail loudly.
 *   - FRED also supplies USREC for the recession bands, and the Atlanta Fed
 *     sticky-price series, which BLS does not publish at all.
 *
 * Raw API responses are cached under data/.cache so re-running while iterating on the
 * site does not burn the BLS free-tier budget (25 requests/day/IP, 10 years/request).
 * Pass --fresh to ignore the cache.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'data', '.cache');
const FRESH = process.argv.includes('--fresh');
const STRICT = process.argv.includes('--strict');

const START_YEAR = 1967; // CUUR0000SA0L12E begins 1967-01; nothing earlier exists.
const END_YEAR = new Date().getUTCFullYear();

const SERIES = {
  coreExShelter: {
    label: 'Core ex-주거비',
    labelEn: 'CPI less food, shelter, and energy',
    bls: { nsa: 'CUUR0000SA0L12E', sa: 'CUSR0000SA0L12E' },
    fred: null, // not carried by FRED
  },
  core: {
    label: 'Core CPI',
    labelEn: 'CPI less food and energy',
    bls: { nsa: 'CUUR0000SA0L1E', sa: 'CUSR0000SA0L1E' },
    fred: { nsa: 'CPILFENS', sa: 'CPILFESL' },
  },
  headline: {
    label: '헤드라인 CPI',
    labelEn: 'CPI all items',
    bls: { nsa: 'CUUR0000SA0', sa: 'CUSR0000SA0' },
    fred: { nsa: 'CPIAUCNS', sa: 'CPIAUCSL' },
  },
  shelter: {
    label: '주거비',
    labelEn: 'CPI shelter',
    bls: { nsa: 'CUUR0000SAH1', sa: 'CUSR0000SAH1' },
    fred: { nsa: 'CUUR0000SAH1', sa: 'CUSR0000SAH1' },
  },
};

/**
 * Atlanta Fed sticky-price CPI: the CPI basket reweighted by how often each
 * component's price changes, not a subset of it. FRED publishes these already as
 * rates rather than index levels, so they are used as published — there is no
 * index to recompute from, and no BLS equivalent exists.
 */
const FRED_RATES = {
  stickyExShelter: {
    label: 'Sticky ex-주거비',
    labelEn: 'Sticky Price CPI less food, energy, and shelter',
    fields: {
      yoy: 'CRESTKCPIXSLTRM159SFRBATL', // units: Percent Change from Year Ago
      ann3m: 'CRESTKCPIXSLTRM679SFRBATL', // units: 3-Month Annualized Percent Change
    },
  },
};

// ---------------------------------------------------------------- utilities

const log = (...a) => console.log(...a);

async function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Transient network/5xx failures shouldn't fail a scheduled run. */
async function withRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.fatal || i === attempts) break;
      const wait = 3000 * i;
      log(`  retry ${i}/${attempts - 1} ${label} in ${wait}ms — ${err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function cached(key, producer) {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!FRESH && existsSync(file)) {
    log(`  cache hit  ${key}`);
    return JSON.parse(await readFile(file, 'utf8'));
  }
  const value = await producer();
  await writeFile(file, JSON.stringify(value));
  log(`  fetched    ${key}`);
  return value;
}

/** "1967-01" <-> index arithmetic on a continuous monthly axis. */
const ymKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
function monthRange(startKey, endKey) {
  const [sy, sm] = startKey.split('-').map(Number);
  const [ey, em] = endKey.split('-').map(Number);
  const out = [];
  for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m === 12 ? (m = 1, y++) : m++) {
    out.push(ymKey(y, m));
  }
  return out;
}

// ---------------------------------------------------------------- BLS

/**
 * One request covers up to 25 series, so all 8 go in each batch; the year span per
 * request is what differs between API versions.
 *
 * v1 (no key): 10 years/request, 25 requests/day/IP. Fine locally, but shared CI
 * runners share that IP quota with everyone else on the box.
 * v2 (free key from bls.gov/developers): 20 years/request, 500 requests/day, and the
 * quota is tied to the key rather than the IP. Set BLS_API_KEY to use it.
 *
 * Returns Map<seriesId, Map<"YYYY-MM", number>>.
 */
async function fetchBLS(seriesIds, apiKey) {
  const version = apiKey ? 'v2' : 'v1';
  const span = apiKey ? 20 : 10;
  const url = `https://api.bls.gov/publicAPI/${version}/timeseries/data/`;

  const byId = new Map(seriesIds.map((id) => [id, new Map()]));
  const chunks = [];
  for (let y = START_YEAR; y <= END_YEAR; y += span) {
    chunks.push([y, Math.min(y + span - 1, END_YEAR)]);
  }
  log(`BLS (primary, ${version}) — ${seriesIds.length} series, ${chunks.length} batches:`);

  for (const [sy, ey] of chunks) {
    const json = await cached(`bls_${version}_${sy}_${ey}`, () =>
      withRetry(`BLS ${sy}-${ey}`, async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            seriesid: seriesIds,
            startyear: String(sy),
            endyear: String(ey),
            ...(apiKey ? { registrationkey: apiKey } : {}),
          }),
        });
        if (!res.ok) throw new Error(`BLS HTTP ${res.status}`);
        return res.json();
      }));

    if (json.status !== 'REQUEST_SUCCEEDED') {
      throw new Error(`BLS ${sy}-${ey} failed: ${json.status} ${JSON.stringify(json.message)}`);
    }

    for (const s of json.Results?.series ?? []) {
      const target = byId.get(s.seriesID);
      if (!target) continue;
      for (const d of s.data) {
        // M13 is the annual average, not a month — it would corrupt the axis.
        if (!/^M(0[1-9]|1[0-2])$/.test(d.period)) continue;
        // "-" marks a genuinely unpublished month (e.g. the 2025 shutdown gap).
        if (d.value === '-' || d.value === '') continue;
        const v = Number(d.value);
        if (Number.isFinite(v)) target.set(`${d.year}-${d.period.slice(1)}`, v);
      }
    }
  }
  return byId;
}

// ---------------------------------------------------------------- FRED

async function fetchFRED(seriesId, apiKey) {
  const json = await cached(`fred_${seriesId}`, () =>
    withRetry(`FRED ${seriesId}`, async () => {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}` +
        `&api_key=${apiKey}&file_type=json`;
      const res = await fetch(url);
      const j = await res.json();
      // A bad key or unknown series will never succeed — don't burn retries on it.
      if (j.error_message) {
        const err = new Error(`FRED ${seriesId}: ${j.error_message}`);
        err.fatal = res.status === 400;
        throw err;
      }
      return j;
    }));

  const out = new Map();
  for (const o of json.observations ?? []) {
    if (o.value === '.') continue; // FRED's missing-value marker
    const v = Number(o.value);
    if (Number.isFinite(v)) out.set(o.date.slice(0, 7), v);
  }
  return out;
}

// ---------------------------------------------------------------- derived metrics

/** Year-over-year % change. Computed from NSA, which is the convention for YoY. */
function yoy(values) {
  return values.map((v, i) => {
    const prev = values[i - 12];
    return v == null || prev == null || i < 12 ? null : round2(((v / prev) - 1) * 100);
  });
}

/** N-month change, annualized. Computed from SA — an unadjusted MoM would be seasonal noise. */
function annualized(values, n) {
  const periodsPerYear = 12 / n;
  return values.map((v, i) => {
    const prev = values[i - n];
    return v == null || prev == null || i < n
      ? null
      : round2((Math.pow(v / prev, periodsPerYear) - 1) * 100);
  });
}

const round2 = (x) => Math.round(x * 100) / 100;

/** Collapse the 0/1 USREC series into [{start, end}] bands. */
function recessionBands(usrec, months) {
  const bands = [];
  let open = null;
  for (const m of months) {
    const inRecession = usrec.get(m) === 1;
    if (inRecession && !open) open = { start: m, end: m };
    else if (inRecession) open.end = m;
    else if (open) { bands.push(open); open = null; }
  }
  if (open) bands.push(open);
  return bands;
}

// ---------------------------------------------------------------- main

async function main() {
  const env = { ...(await loadEnv()), ...process.env };
  const fredKey = env.FRED_API_KEY;

  const blsIds = Object.values(SERIES).flatMap((s) => [s.bls.nsa, s.bls.sa]);

  let blsData = new Map();
  let blsError = null;
  try {
    blsData = await fetchBLS(blsIds, env.BLS_API_KEY);
  } catch (err) {
    blsError = err;
    log(`  ! BLS unavailable: ${err.message}`);
  }

  // Resolve each series/adjustment from BLS, falling back to FRED where possible.
  const provenance = {};
  const raw = {};
  for (const [key, def] of Object.entries(SERIES)) {
    raw[key] = {};
    provenance[key] = {};
    for (const adj of ['nsa', 'sa']) {
      const fromBls = blsData.get(def.bls[adj]);
      if (fromBls && fromBls.size > 0) {
        raw[key][adj] = fromBls;
        provenance[key][adj] = { source: 'BLS', id: def.bls[adj] };
        continue;
      }
      if (def.fred && fredKey) {
        log(`  fallback to FRED for ${key}.${adj}`);
        raw[key][adj] = await fetchFRED(def.fred[adj], fredKey);
        provenance[key][adj] = { source: 'FRED', id: def.fred[adj] };
        continue;
      }
      throw new Error(
        `No source for ${key}.${adj}. BLS failed (${blsError?.message ?? 'empty result'})` +
        (def.fred ? ' and no FRED key is set.' : ' and FRED does not carry this series.')
      );
    }
  }

  // A single continuous monthly axis, ending at the last month any series reports.
  let lastMonth = '';
  for (const key of Object.keys(SERIES)) {
    for (const adj of ['nsa', 'sa']) {
      for (const m of raw[key][adj].keys()) if (m > lastMonth) lastMonth = m;
    }
  }
  const months = monthRange(`${START_YEAR}-01`, lastMonth);

  const series = {};
  for (const [key, def] of Object.entries(SERIES)) {
    const nsa = months.map((m) => raw[key].nsa.get(m) ?? null);
    const sa = months.map((m) => raw[key].sa.get(m) ?? null);
    series[key] = {
      label: def.label,
      labelEn: def.labelEn,
      yoy: yoy(nsa),
      ann3m: annualized(sa, 3),
      ann6m: annualized(sa, 6),
      indexNsa: nsa,
      source: provenance[key],
    };
  }

  // Sticky-price series, already expressed as rates. FRED-only: without a key the
  // site simply renders without them.
  for (const [key, def] of Object.entries(FRED_RATES)) {
    if (!fredKey) {
      log(`  ! no FRED key, skipping ${key}`);
      continue;
    }
    try {
      const out = { label: def.label, labelEn: def.labelEn, adjustment: 'SA', source: {} };
      for (const [field, id] of Object.entries(def.fields)) {
        const got = await fetchFRED(id, fredKey);
        out[field] = months.map((m) => {
          const v = got.get(m);
          return v == null ? null : round2(v);
        });
        out.source[field] = { source: 'FRED', id };
      }
      series[key] = out;
    } catch (err) {
      log(`  ! ${key} unavailable: ${err.message}`);
    }
  }

  // Recession bands. USREC is FRED-only; without a key the site simply omits shading.
  let recessions = [];
  if (fredKey) {
    try {
      recessions = recessionBands(await fetchFRED('USREC', fredKey), months);
    } catch (err) {
      log(`  ! USREC unavailable, shipping without recession shading: ${err.message}`);
    }
  }

  // Months the government never published, so the chart can break the line instead of
  // interpolating across a hole. The 2025 shutdown is the live example.
  const missing = months.filter(
    (m, i) => series.coreExShelter.indexNsa[i] == null && m <= lastMonth
  );

  // FRED carries a sticky-price value for the shutdown month even though BLS never
  // published an October 2025 CPI. Record the overlap so the site can say so instead
  // of quietly implying that month exists in both.
  const missingButSticky = missing.filter(
    (m) => series.stickyExShelter?.yoy[months.indexOf(m)] != null
  );

  const payload = {
    generatedAt: null, // filled in below, once we know whether anything changed
    startMonth: months[0],
    latestMonth: lastMonth,
    months,
    series,
    recessions,
    missing,
    missingButSticky,
    meta: {
      blsFailed: Boolean(blsError),
      note: 'YoY는 계절조정 전(NSA), 3/6개월 연율화는 계절조정(SA) 계열로 계산했습니다.',
    },
  };

  const jsonPath = path.join(ROOT, 'data', 'cpi.json');

  // Locally, a missing FRED key just means the sticky lines and recession bands are
  // absent. On a schedule that commits its own output, that same degradation would
  // quietly publish a regression — so --strict makes it a failure instead. Compared
  // against the previous build, it catches any cause: a missing key, a renamed
  // series, an upstream outage.
  if (STRICT) {
    const problems = [];
    if (!fredKey) problems.push('FRED_API_KEY is not set');
    if (!recessions.length) problems.push('no recession bands came back (USREC)');
    if (existsSync(jsonPath)) {
      try {
        const prev = JSON.parse(await readFile(jsonPath, 'utf8'));
        for (const key of Object.keys(prev.series ?? {})) {
          if (!series[key]) problems.push(`series "${key}" disappeared since the last build`);
        }
        if (months.length < (prev.months?.length ?? 0)) {
          problems.push(`month count shrank: ${prev.months.length} -> ${months.length}`);
        }
      } catch {
        // No readable previous build to compare against; the checks above still apply.
      }
    }
    if (problems.length) {
      throw new Error('--strict: refusing to write a degraded build\n  - ' + problems.join('\n  - '));
    }
  }

  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  await mkdir(path.join(ROOT, 'public'), { recursive: true });

  // A timestamp that moves on every run would make the scheduled job commit daily
  // even when BLS published nothing. Compare everything *except* the timestamp and
  // reuse the old one when the numbers match, so a quiet day writes byte-identical
  // files and leaves no diff. generatedAt therefore means "data last changed".
  const withoutStamp = (o) => JSON.stringify({ ...o, generatedAt: null });
  let unchanged = false;
  if (existsSync(jsonPath)) {
    try {
      const prev = JSON.parse(await readFile(jsonPath, 'utf8'));
      if (withoutStamp(prev) === withoutStamp(payload) && prev.generatedAt) {
        payload.generatedAt = prev.generatedAt;
        unchanged = true;
      }
    } catch {
      // Unreadable previous file — treat as changed and rewrite.
    }
  }
  if (!payload.generatedAt) payload.generatedAt = new Date().toISOString();

  const json = JSON.stringify(payload);
  await writeFile(path.join(ROOT, 'data', 'cpi.json'), JSON.stringify(payload, null, 2));
  // A JS assignment rather than a .json fetch, so index.html works when opened
  // directly from disk (file:// blocks fetch of sibling files).
  await writeFile(path.join(ROOT, 'public', 'data.js'), `window.CPI_DATA = ${json};\n`);

  const last = series.coreExShelter.yoy[months.length - 1];
  log('');
  log(`months        ${months[0]} … ${lastMonth}  (${months.length})`);
  log(`series        ${Object.keys(series).join(', ')}`);
  log(`missing       ${missing.length ? missing.join(', ') : 'none'}` +
      (missingButSticky.length ? `  (sticky still reports: ${missingButSticky.join(', ')})` : ''));
  log(`recessions    ${recessions.length}`);
  log(`latest YoY    core ex-shelter = ${last == null ? 'n/a' : last + '%'}` +
      (series.stickyExShelter
        ? ` · sticky ex-shelter = ${series.stickyExShelter.yoy[months.length - 1] ?? 'n/a'}%`
        : ''));
  log(`changed       ${unchanged ? 'no — output is byte-identical to the previous run' : 'yes'}`);
  log(`written       data/cpi.json, public/data.js (${(json.length / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
