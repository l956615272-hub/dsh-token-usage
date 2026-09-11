/**
 * UsageStore: an in-memory snapshot of every usage record, kept warm by a
 * periodic incremental scan and persisted to disk for instant first paint.
 *
 * Incremental strategy: each session file is remembered with its
 * (mtimeMs, size). A refresh re-decodes only files whose signature changed and
 * drops files that disappeared; the merged, de-duplicated record set is then
 * rebuilt from the per-file records.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { listSessionFiles, mergeRecords, scanFile } from './scan.js';
import { coverageOf } from './aggregate.js';

const CACHE_VERSION = 1;

function defaultCachePath(options) {
  if (options.cachePath) return options.cachePath;
  const home = process.env.DSH_HOME || (options.homes && options.homes[0]) || join(homedir(), '.dsh');
  return join(home, 'dsh-token-usage', 'cache.json');
}

export class UsageStore {
  constructor(options = {}) {
    this.homes = options.homes || [];
    this.timeZone = options.timeZone || 'Asia/Shanghai';
    this.scanIntervalMs = typeof options.scanIntervalMs === 'number' ? options.scanIntervalMs : 60000;
    this.logger = options.logger || console;
    this.cachePath = defaultCachePath(options);
    this.cacheEnabled = options.cache !== false;
    this._records = [];
    this._fileRecords = new Map();
    this._revision = 0;
    this._scanning = null;
    this._timer = null;
    this._disposed = false;
    this._listeners = new Set();
    this._meta = {
      files: 0,
      homes: this.homes,
      records: 0,
      sessions: 0,
      firstDay: null,
      lastDay: null,
      scanMs: 0,
      lastScanAt: null,
      scanning: false,
      lastError: null,
      fromCache: false,
      timeZone: this.timeZone
    };
  }

  /** Load the disk cache, start the periodic refresh, and kick off a scan. */
  start() {
    this._loadCache();
    const tick = () => {
      this.refresh().catch((error) => {
        this.logger.warn('[dsh-token-usage] scan failed: ' + (error && error.message));
      });
    };
    this._timer = setInterval(tick, this.scanIntervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    tick();
    return () => this.dispose();
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  getSnapshot() {
    return { revision: this._revision, records: this._records, meta: this._meta };
  }

  /** Rebuild the aggregate now. Concurrent calls share one scan. */
  refresh() {
    if (this._scanning) return this._scanning;
    const promise = this._scan().finally(() => { this._scanning = null; });
    this._scanning = promise;
    return promise;
  }

  dispose() {
    this._disposed = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._listeners.clear();
  }

  async _scan() {
    const started = Date.now();
    const files = listSessionFiles(this.homes);
    const nextFileRecords = new Map();
    let failures = 0;
    for (const file of files) {
      const previous = this._fileRecords.get(file.path);
      if (previous && previous.signature && previous.signature.mtimeMs === file.mtimeMs && previous.signature.size === file.size) {
        nextFileRecords.set(file.path, previous);
        continue;
      }
      try {
        const result = scanFile(file.path, file.workspace);
        nextFileRecords.set(file.path, {
          signature: { mtimeMs: file.mtimeMs, size: file.size },
          records: result.records
        });
      } catch (error) {
        failures += 1;
        this.logger.warn('[dsh-token-usage] cannot read ' + file.path + ': ' + (error && error.message));
      }
    }
    this._fileRecords = nextFileRecords;
    const merged = mergeRecords([...nextFileRecords.values()].map((entry) => entry.records));
    this._records = merged;
    const coverage = coverageOf(merged, this.timeZone);
    this._meta = {
      files: files.length,
      homes: this.homes,
      records: coverage.records,
      sessions: coverage.sessions,
      firstDay: coverage.firstDay,
      lastDay: coverage.lastDay,
      scanMs: Date.now() - started,
      lastScanAt: Date.now(),
      scanning: false,
      lastError: failures > 0 ? failures + ' file(s) failed to read' : null,
      fromCache: false,
      timeZone: this.timeZone
    };
    this._revision += 1;
    this._saveCache();
    this._notify();
  }

  _notify() {
    const snapshot = this.getSnapshot();
    for (const listener of this._listeners) {
      try { listener(snapshot); } catch (error) { this.logger.warn('[dsh-token-usage] listener failed: ' + (error && error.message)); }
    }
  }

  _loadCache() {
    if (!this.cacheEnabled || !existsSync(this.cachePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8'));
      if (!parsed || parsed.version !== CACHE_VERSION || !Array.isArray(parsed.records)) return;
      this._records = parsed.records;
      const coverage = coverageOf(this._records, this.timeZone);
      this._meta = {
        ...this._meta,
        records: coverage.records,
        sessions: coverage.sessions,
        firstDay: coverage.firstDay,
        lastDay: coverage.lastDay,
        lastScanAt: parsed.generatedAt || null,
        fromCache: true
      };
      this._revision += 1;
    } catch (error) {
      this.logger.warn('[dsh-token-usage] ignoring unreadable cache: ' + (error && error.message));
    }
  }

  _saveCache() {
    if (!this.cacheEnabled) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const temporary = this.cachePath + '.' + process.pid + '.tmp';
      writeFileSync(temporary, JSON.stringify({
        version: CACHE_VERSION,
        generatedAt: Date.now(),
        records: this._records
      }));
      renameSync(temporary, this.cachePath);
    } catch (error) {
      this.logger.warn('[dsh-token-usage] cannot write cache: ' + (error && error.message));
    }
  }
}
