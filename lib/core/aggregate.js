/**
 * Time-window resolution, summarisation and grouping over usage records.
 *
 * Day boundaries are always computed in the configured IANA time zone, never
 * from the host process TZ, so the numbers stay stable wherever dsh runs.
 */
const DAY_FORMATTERS = new Map();

function dayFormatter(timeZone) {
  let formatter = DAY_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    DAY_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

const PARTS_FORMATTERS = new Map();

function partsFormatter(timeZone) {
  let formatter = PARTS_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    PARTS_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(epoch, timeZone) {
  const parts = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(epoch))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

function zoneOffsetMs(epoch, timeZone) {
  const parts = zonedParts(epoch, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - epoch;
}

/** Epoch ms of local midnight for a YYYY-MM-DD day in `timeZone`. */
export function zonedDayStart(day, timeZone) {
  const parts = day.split('-').map(Number);
  const guess = Date.UTC(parts[0], parts[1] - 1, parts[2], 0, 0, 0);
  const offset = zoneOffsetMs(guess, timeZone);
  const corrected = zoneOffsetMs(guess - offset, timeZone);
  return guess - corrected;
}

/** YYYY-MM-DD of an epoch in `timeZone`. */
export function dayKey(epoch, timeZone) {
  return dayFormatter(timeZone).format(new Date(epoch));
}

/** Shift a YYYY-MM-DD day by whole days (calendar arithmetic, TZ-free). */
export function addDays(day, amount) {
  const parts = day.split('-').map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

/** Today's YYYY-MM-DD in `timeZone`. */
export function todayKey(timeZone, now) {
  return dayKey(now == null ? Date.now() : now, timeZone);
}

/** Clamp a subscription refresh day into 1..31. */
export function clampDay(value) {
  const day = Math.round(Number(value));
  if (!Number.isFinite(day)) return 1;
  return Math.min(31, Math.max(1, day));
}

/**
 * Time-bucket granularity chain, finest to coarsest. A time dimension maps a
 * record's epoch into a YYYY-MM-DD(-based) bucket key in the configured zone.
 */
export const TIME_DIMS = ['5m', '15m', '30m', 'hour', '3h', '6h', 'day', 'week', 'month'];
export const BUCKET_MS = { '5m': 5 * 60000, '15m': 15 * 60000, '30m': 30 * 60000, hour: 3600000, '3h': 3 * 3600000, '6h': 6 * 3600000, day: 86400000, week: 7 * 86400000, month: 30.44 * 86400000 };
/** Hard cap on rendered buckets; finer options are disabled in the picker and the backend coarsens as a second line of defense. */
export const MAX_BUCKETS = 1000;

function isTimeDim(dimension) {
  return TIME_DIMS.indexOf(dimension) >= 0;
}

/** Zoned bucket key for a time dimension: 5m/15m/30m -> 'YYYY-MM-DD HH:mm', hour -> 'YYYY-MM-DD HH:00'. */
function minuteBucketKey(epoch, minutes, timeZone) {
  const parts = zonedParts(epoch, timeZone);
  const minute = Math.floor(Number(parts.minute) / minutes) * minutes;
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + String(minute).padStart(2, '0');
}

function timeBucketKey(epoch, dimension, timeZone) {
  if (dimension === '5m' || dimension === '15m' || dimension === '30m') {
    return minuteBucketKey(epoch, Number(dimension.slice(0, -1)), timeZone);
  }
  if (dimension === 'hour' || dimension === '3h' || dimension === '6h') {
    const parts = zonedParts(epoch, timeZone);
    const size = dimension === 'hour' ? 1 : Number(dimension.slice(0, -1));
    const hour = Math.floor(Number(parts.hour) / size) * size;
    return parts.year + '-' + parts.month + '-' + parts.day + ' ' + String(hour).padStart(2, '0') + ':00';
  }
  if (dimension === 'day') return dayKey(epoch, timeZone);
  if (dimension === 'week') {
    // Bucket by the Monday of the local week. Deriving the weekday from the
    // day key keeps this independent of ICU weekday-name spellings.
    const day = dayKey(epoch, timeZone);
    const weekday = new Date(day + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
    const backToMonday = (weekday + 6) % 7;
    return backToMonday === 0 ? day : addDays(day, -backToMonday);
  }
  if (dimension === 'month') {
    return dayKey(epoch, timeZone).slice(0, 7);
  }
  return dayKey(epoch, timeZone);
}

/**
 * Guardrail: escalate the granularity until the estimated bucket count fits
 * under MAX_BUCKETS for the resolved window. Open bounds fall back to the
 * records' own time span. Returns the effective dimension.
 */
export function coarsenGroupBy(dimension, range, records) {
  if (!isTimeDim(dimension)) return dimension;
  let from = range && range.fromMs != null ? range.fromMs : null;
  let to = range && range.toMs != null ? range.toMs : null;
  if (from == null || to == null) {
    for (const record of records) {
      const time = record.time || 0;
      if (time <= 0) continue;
      if (from == null || time < from) from = time;
      if (to == null || time > to) to = time;
    }
  }
  if (from == null || to == null) return dimension;
  let index = TIME_DIMS.indexOf(dimension);
  while (index < TIME_DIMS.length - 1 && (to - from) / BUCKET_MS[TIME_DIMS[index]] > MAX_BUCKETS) index += 1;
  return TIME_DIMS[index];
}

/**
 * Auto granularity for the chart: the single range selector drives the x axis,
 * so pick a bucket size that keeps a short range detailed without turning a
 * long range into a solid block. The thresholds intentionally give 2-3 days
 * hourly bars instead of 2-3 daily bars.
 *
 *   1-3 days -> hour   4-7 days -> 3h   8-14 days -> 6h
 *   15-90 days -> day  91-700 days -> week   >700 days -> month
 */
export function autoGroupBy(range, records) {
  let from = range && range.fromMs != null ? range.fromMs : null;
  let to = range && range.toMs != null ? range.toMs : null;
  if (from == null || to == null) {
    for (const record of records) {
      const time = record.time || 0;
      if (time <= 0) continue;
      if (from == null || time < from) from = time;
      if (to == null || time + 1 > to) to = time + 1;
    }
  }
  if (from == null || to == null) return 'day';
  const days = Math.max(1, (to - from) / 86400000);
  if (days <= 3) return 'hour';
  if (days <= 7) return '3h';
  if (days <= 14) return '6h';
  if (days <= 90) return 'day';
  if (days <= 700) return 'week';
  return 'month';
}

/** Days in a 1-based month. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Most recent refresh day on or before `today` (YYYY-MM-DD), clamping to the
 * month length so a day-31 cycle still starts on Feb 28/29.
 */
export function cycleStartDay(today, refreshDay) {
  const parts = today.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];
  const thisMonth = year + '-' + pad2(month) + '-' + pad2(Math.min(refreshDay, daysInMonth(year, month)));
  if (today >= thisMonth) return thisMonth;
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return prevYear + '-' + pad2(prevMonth) + '-' + pad2(Math.min(refreshDay, daysInMonth(prevYear, prevMonth)));
}

/**
 * Resolve a range preset into an exclusive-upper-bound epoch window.
 * kind: all | today | 7d | 30d | month | custom | cycle
 *
 * custom is one-sided friendly, matching the UI contract:
 *   from only -> from that day through now (open upper bound)
 *   to only   -> everything up to and including that day (open lower bound)
 *   both      -> that inclusive day window
 *
 * cycle is the current quota cycle: the most recent occurrence of
 * `cycleDay` on or before today (clamped to the month length), through now.
 */
export function resolveRange(kind, options) {
  const timeZone = (options && options.timeZone) || 'Asia/Shanghai';
  const now = options && options.now != null ? options.now : Date.now();
  const from = options && options.from ? options.from : null;
  const to = options && options.to ? options.to : null;
  const today = todayKey(timeZone, now);
  if (kind === 'custom' || (from != null && kind == null)) {
    const fromMs = from ? zonedDayStart(from, timeZone) : null;
    const toMs = to ? zonedDayStart(addDays(to, 1), timeZone) : null;
    const label = from && to ? from + ' ~ ' + to : (from ? from + ' 起至今' : (to ? '截至 ' + to : 'all'));
    return { kind: 'custom', fromMs, toMs, fromDay: from, toDay: to, label };
  }
  if (kind === 'cycle') {
    const refreshDay = clampDay(options && options.cycleDay);
    const start = cycleStartDay(today, refreshDay);
    return { kind: 'cycle', fromMs: zonedDayStart(start, timeZone), toMs: null, fromDay: start, toDay: today, cycleDay: refreshDay, label: 'cycle' };
  }
  if (kind === 'today') {
    return { kind, fromMs: zonedDayStart(today, timeZone), toMs: zonedDayStart(addDays(today, 1), timeZone), fromDay: today, toDay: today, label: 'today' };
  }
  if (kind === '7d' || kind === '30d') {
    const span = kind === '7d' ? 6 : 29;
    const first = addDays(today, -span);
    return { kind, fromMs: zonedDayStart(first, timeZone), toMs: zonedDayStart(addDays(today, 1), timeZone), fromDay: first, toDay: today, label: kind };
  }
  if (kind === 'month') {
    const first = today.slice(0, 8) + '01';
    return { kind, fromMs: zonedDayStart(first, timeZone), toMs: zonedDayStart(addDays(today, 1), timeZone), fromDay: first, toDay: today, label: 'month' };
  }
  return { kind: 'all', fromMs: null, toMs: null, fromDay: null, toDay: null, label: 'all' };
}

export function filterRecords(records, range) {
  if (!range || (range.fromMs == null && range.toMs == null)) return records;
  return records.filter((record) => {
    const time = record.time || 0;
    if (range.fromMs != null && time < range.fromMs) return false;
    if (range.toMs != null && time >= range.toMs) return false;
    return true;
  });
}

/** Sum totals over records. total = input + output + cacheRead. */
export function summarize(records) {
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    calls: 0,
    sessions: 0
  };
  const sessions = new Set();
  for (const record of records) {
    totals.input += record.input || 0;
    totals.output += record.output || 0;
    totals.cacheRead += record.cacheRead || 0;
    totals.cacheWrite += record.cacheWrite || 0;
    totals.reasoning += record.reasoning || 0;
    totals.calls += 1;
    if (record.sessionId) sessions.add(record.sessionId);
  }
  totals.total = totals.input + totals.output + totals.cacheRead;
  totals.sessions = sessions.size;
  return totals;
}

function bucketKey(record, dimension, timeZone) {
  const timeDim = TIME_DIMS.indexOf(dimension);
  if (timeDim >= 0) {
    const key = timeBucketKey(record.time || 0, dimension, timeZone);
    return { key, label: key };
  }
  if (dimension === 'provider') {
    const key = record.provider || '(unknown)';
    return { key, label: key };
  }
  if (dimension === 'model') {
    const key = (record.provider || '(unknown)') + ' / ' + (record.model || '(unknown)');
    return { key, label: key };
  }
  if (dimension === 'family') {
    const raw = String(record.model || '').trim();
    const base = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
    const family = base ? (base.split(/[-_.\s]/)[0] || base) : '(unknown)';
    const key = family.toLowerCase();
    return { key, label: key };
  }
  if (dimension === 'project') {
    const key = record.project || '(unknown)';
    return { key, label: record.projectLabel || key };
  }
  if (dimension === 'session') {
    const key = record.sessionId || '(unknown)';
    return { key, label: key };
  }
  const key = String(record[dimension] == null ? '(unknown)' : record[dimension]);
  return { key, label: key };
}

/** Group records by dimension and return rows sorted by the dimension. */
export function groupRecords(records, dimension, timeZone) {
  const buckets = new Map();
  for (const record of records) {
    const { key, label } = bucketKey(record, dimension, timeZone);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, label, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 };
      buckets.set(key, bucket);
    }
    bucket.input += record.input || 0;
    bucket.output += record.output || 0;
    bucket.cacheRead += record.cacheRead || 0;
    bucket.cacheWrite += record.cacheWrite || 0;
    bucket.reasoning += record.reasoning || 0;
    bucket.calls += 1;
  }
  const rows = [...buckets.values()];
  for (const row of rows) row.total = row.input + row.output + row.cacheRead;
  if (isTimeDim(dimension)) rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  else rows.sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
  return rows;
}

/**
 * Group records by `dimension` (the x axis) and, within each bucket, break the
 * totals down by `seriesDimension` (the stacked segments). Used by the daily
 * stacked bar chart: dimension=day + seriesDimension=model.
 *
 * Returns { rows, series }:
 *  - rows: one row per dimension bucket, each carrying the usual totals plus
 *    `series: [{ key, label, ...totals }]` sorted by the global series order;
 *  - series: the distinct series keys sorted by grand total descending, each
 *    with its own totals, so the client can render a stable legend.
 */
export function groupRecordsStacked(records, dimension, seriesDimension, timeZone) {
  const buckets = new Map();
  const seriesTotals = new Map();
  for (const record of records) {
    const { key, label } = bucketKey(record, dimension, timeZone);
    const seriesKey = bucketKey(record, seriesDimension, timeZone);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, label, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0, series: new Map() };
      buckets.set(key, bucket);
    }
    let series = bucket.series.get(seriesKey.key);
    if (!series) {
      series = { key: seriesKey.key, label: seriesKey.label, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 };
      bucket.series.set(seriesKey.key, series);
    }
    const input = record.input || 0;
    const output = record.output || 0;
    const cacheRead = record.cacheRead || 0;
    const cacheWrite = record.cacheWrite || 0;
    const reasoning = record.reasoning || 0;
    const recordTotal = input + output + cacheRead;
    for (const target of [bucket, series]) {
      target.input += input;
      target.output += output;
      target.cacheRead += cacheRead;
      target.cacheWrite += cacheWrite;
      target.reasoning += reasoning;
      target.calls += 1;
      target.total += recordTotal;
    }
    let globalSeries = seriesTotals.get(seriesKey.key);
    if (!globalSeries) {
      globalSeries = { key: seriesKey.key, label: seriesKey.label, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 };
      seriesTotals.set(seriesKey.key, globalSeries);
    }
    globalSeries.input += input;
    globalSeries.output += output;
    globalSeries.cacheRead += cacheRead;
    globalSeries.cacheWrite += cacheWrite;
    globalSeries.reasoning += reasoning;
    globalSeries.calls += 1;
    globalSeries.total += recordTotal;
  }
  const seriesOrder = [...seriesTotals.values()].sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
  const orderIndex = new Map(seriesOrder.map((item, index) => [item.key, index]));
  const rows = [...buckets.values()].map((bucket) => {
    const series = [...bucket.series.values()].sort(
      (a, b) => (orderIndex.get(a.key) || 0) - (orderIndex.get(b.key) || 0)
    );
    return { ...bucket, series };
  });
  if (isTimeDim(dimension)) rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  else rows.sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
  return { rows, series: seriesOrder };
}

/** Non-time dimensions that may be used as a stacked series. */
const SERIES_DIMS = new Set(['model', 'family', 'provider', 'project', 'session']);

function emptyTimeRow(key, stacked) {
  const row = { key, label: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 };
  if (stacked) row.series = [];
  return row;
}

/**
 * Enumerate every bucket key in [fromMs, toMs), coarsest dimension first.
 * `toMs` is exclusive; the last key covers toMs - 1.
 */
function timeBucketKeys(fromMs, toMs, dimension, timeZone) {
  const keys = [];
  if (fromMs == null || toMs == null || toMs <= fromMs) return keys;
  if (dimension === 'day' || dimension === 'week' || dimension === 'month') {
    let key = timeBucketKey(fromMs, dimension, timeZone);
    const endKey = timeBucketKey(toMs - 1, dimension, timeZone);
    while (keys.length < MAX_BUCKETS) {
      keys.push(key);
      if (key >= endKey) break;
      if (dimension === 'month') {
        const parts = key.split('-').map(Number);
        const year = parts[1] === 12 ? parts[0] + 1 : parts[0];
        const month = parts[1] === 12 ? 1 : parts[1] + 1;
        key = year + '-' + pad2(month);
      } else {
        key = addDays(key, dimension === 'week' ? 7 : 1);
      }
    }
    return keys;
  }
  const step = BUCKET_MS[dimension];
  if (!step) return keys;
  const seen = new Set();
  for (let time = fromMs; time < toMs && keys.length < MAX_BUCKETS; time += step) {
    const key = timeBucketKey(time, dimension, timeZone);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Insert zero rows for empty time buckets so a trend chart shows real gaps
 * instead of collapsing two distant days into adjacent bars. Only used when
 * buildSummary is called with fill: true (the chart requests it); the table
 * keeps the sparse, backwards-compatible rows.
 */
export function fillTimeBuckets(rows, dimension, range, records, timeZone, stacked) {
  if (!isTimeDim(dimension) || records.length === 0) return rows;
  let fromMs = range && range.fromMs != null ? range.fromMs : null;
  let toMs = range && range.toMs != null ? range.toMs : null;
  if (fromMs == null || toMs == null) {
    for (const record of records) {
      const time = record.time || 0;
      if (time <= 0) continue;
      if (fromMs == null || time < fromMs) fromMs = time;
      if (toMs == null || time + 1 > toMs) toMs = time + 1;
    }
  }
  if (fromMs == null || toMs == null) return rows;
  const keys = timeBucketKeys(fromMs, toMs, dimension, timeZone);
  if (keys.length === 0) return rows;
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const filled = keys.map((key) => byKey.get(key) || emptyTimeRow(key, stacked));
  if (filled.length !== rows.length) {
    // Defensive: never drop a real row if a key generator edge case misses it.
    const seen = new Set(filled.map((row) => row.key));
    for (const row of rows) if (!seen.has(row.key)) filled.push(row);
    filled.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  return filled;
}

/** Build the full response payload served to the client and the report CLI. */
export function buildSummary(records, options) {
  const timeZone = options.timeZone || 'Asia/Shanghai';
  const range = resolveRange(options.range || 'all', {
    timeZone,
    now: options.now,
    from: options.from,
    to: options.to,
    cycleDay: options.cycleDay
  });
  const filtered = filterRecords(records, range);
  const totals = summarize(filtered);
  const requestedGroupBy = options.groupBy || 'day';
  // 'auto' is the chart's single time axis: the selected range decides the
  // bucket size. Explicit time dimensions keep the 1000-bucket guardrail;
  // callers that need exact buckets (report CLI) opt out with coarsen: false.
  const groupBy = requestedGroupBy === 'auto'
    ? autoGroupBy(range, filtered)
    : (options.coarsen === false ? requestedGroupBy : coarsenGroupBy(requestedGroupBy, range, records));
  const coarsened = requestedGroupBy !== 'auto' && groupBy !== requestedGroupBy;
  const series = options.series && options.series !== groupBy && SERIES_DIMS.has(options.series) ? options.series : null;
  const fill = options.fill === true;
  const base = {
    generatedAt: Date.now(),
    range,
    groupBy,
    requestedGroupBy: coarsened ? requestedGroupBy : undefined,
    totals,
    coverage: options.coverage || null
  };
  if (series) {
    const stacked = groupRecordsStacked(filtered, groupBy, series, timeZone);
    const groups = fill ? fillTimeBuckets(stacked.rows, groupBy, range, filtered, timeZone, true) : stacked.rows;
    return { ...base, series, groups, seriesOrder: stacked.series };
  }
  const groups = groupRecords(filtered, groupBy, timeZone);
  return { ...base, groups: fill ? fillTimeBuckets(groups, groupBy, range, filtered, timeZone, false) : groups };
}

/** Compute coverage metadata (first/last day, distinct sessions) over records. */
export function coverageOf(records, timeZone) {
  let firstTime = null;
  let lastTime = null;
  const sessions = new Set();
  for (const record of records) {
    const time = record.time || 0;
    if (time > 0) {
      if (firstTime == null || time < firstTime) firstTime = time;
      if (lastTime == null || time > lastTime) lastTime = time;
    }
    if (record.sessionId) sessions.add(record.sessionId);
  }
  return {
    records: records.length,
    sessions: sessions.size,
    firstDay: firstTime == null ? null : dayKey(firstTime, timeZone),
    lastDay: lastTime == null ? null : dayKey(lastTime, timeZone)
  };
}
