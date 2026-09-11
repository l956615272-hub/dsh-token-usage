/**
 * Session log scanning: enumerate session files, decode them, and extract one
 * usage record per final assistant message.
 *
 * Correctness contract (validated against the dsh-usage ledger):
 *   - only assistant/message usage is counted; assistant/chunk usage repeats it;
 *   - records are keyed by message.id so v0/v3 files and resume/fork copies of
 *     the same session collapse into one record.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { decodeZstdFile } from './zstd.js';
import { decodeWorkspaceName } from './paths.js';

const SESSION_FILE_RE = /^session.*\.jsonl\.zstd$/;

/** Enumerate every session log file under the given DSH homes. */
export function listSessionFiles(homes) {
  const out = [];
  const seen = new Set();
  for (const home of homes) {
    const root = join(home, 'sessions');
    let workspaces;
    try { workspaces = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const workspaceDir = join(root, workspace.name);
      let sessions;
      try { sessions = readdirSync(workspaceDir, { withFileTypes: true }); } catch { continue; }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const sessionDir = join(workspaceDir, session.name);
        let files;
        try { files = readdirSync(sessionDir); } catch { continue; }
        for (const file of files) {
          if (!SESSION_FILE_RE.test(file)) continue;
          const path = join(sessionDir, file);
          let real = path;
          try { real = realpathSync(path); } catch { /* keep path */ }
          if (seen.has(real)) continue;
          seen.add(real);
          let stat;
          try { stat = statSync(path); } catch { continue; }
          out.push({
            path,
            home,
            workspace: workspace.name,
            sessionDir: session.name,
            file,
            size: stat.size,
            mtimeMs: stat.mtimeMs
          });
        }
      }
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Resolve the project path/label of a session from its cwd (fallback: workspace dir name). */
export function projectOf(cwd, workspace) {
  const path = typeof cwd === 'string' && cwd.length > 0 ? cwd : decodeWorkspaceName(workspace);
  const label = basename(path) || path || '(unknown)';
  return { project: path, projectLabel: label };
}

/** Decode one session file and return its usage records plus session header. */
export function scanFile(path, workspace) {
  const text = decodeZstdFile(path);
  const records = [];
  let session = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (session === null && line.includes('"type":"session"')) {
      try {
        const candidate = JSON.parse(line);
        if (candidate && candidate.type === 'session') session = candidate;
      } catch { /* not the header line */ }
    }
    if (!line.includes('"inputTokens"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || event.type !== 'assistant/message') continue;
    const data = event.data || {};
    const usage = data.usage;
    if (!usage || typeof usage.inputTokens !== 'number') continue;
    const message = data.message || {};
    const source = message.source || {};
    const sessionId = session && typeof session.id === 'string' ? session.id : null;
    const messageId = typeof message.id === 'string' ? message.id : null;
    const key = messageId
      ? 'm:' + messageId
      : (sessionId || 'unknown') + '::' + data.turn + '::' + data.step;
    const project = projectOf(session && session.cwd, workspace);
    records.push({
      key,
      sessionId,
      messageId,
      turn: typeof data.turn === 'number' ? data.turn : null,
      step: typeof data.step === 'number' ? data.step : null,
      time: typeof event.time === 'number' ? event.time : (session && session.createdAt) || 0,
      provider: typeof source.provider === 'string' ? source.provider : null,
      model: typeof source.model === 'string' ? source.model : null,
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      cacheRead: num(usage.cacheReadTokens),
      cacheWrite: num(usage.cacheWriteTokens),
      reasoning: num(usage.reasoningTokens),
      project: project.project,
      projectLabel: project.projectLabel,
      cwd: session && typeof session.cwd === 'string' ? session.cwd : null
    });
  }
  return { session, records };
}

/** Deduplicate record lists from many files by message key (first wins). */
export function mergeRecords(recordLists) {
  const merged = new Map();
  for (const records of recordLists) {
    for (const record of records) {
      if (!merged.has(record.key)) merged.set(record.key, record);
    }
  }
  return [...merged.values()];
}
