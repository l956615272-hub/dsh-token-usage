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

function zonedParts(epoch, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(epoch))) {
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

/**
 * Resolve a range preset into an exclusive-upper-bound epoch window.
 * kind: all | today | 7d | 30d | month | custom
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
    return { kind: 'custom', fromMs, toMs, fromDay: from, toDay: to, label: (from || '...') + ' ~ ' + (to || '...') };
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
  if (dimension === 'day') {
    const key = dayKey(record.time || 0, timeZone);
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
  if (dimension === 'day') rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  else rows.sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
  return rows;
}

/** Build the full response payload served to the client and the report CLI. */
export function buildSummary(records, options) {
  const timeZone = options.timeZone || 'Asia/Shanghai';
  const range = resolveRange(options.range || 'all', {
    timeZone,
    now: options.now,
    from: options.from,
    to: options.to
  });
  const filtered = filterRecords(records, range);
  const totals = summarize(filtered);
  const groupBy = options.groupBy || 'day';
  const groups = groupRecords(filtered, groupBy, timeZone);
  return {
    generatedAt: Date.now(),
    range,
    groupBy,
    totals,
    groups,
    coverage: options.coverage || null
  };
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
