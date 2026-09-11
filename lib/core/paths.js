/**
 * DSH home discovery.
 *
 * A machine can hold several DSH homes (the env-selected one, the classic
 * ~/.dsh, and legacy ~/.dsh_desktop/<version> trees). Global totals must span
 * all of them, so every existing home with a sessions/ directory is scanned.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Resolve every DSH home directory that may hold session logs. */
export function resolveDshHomes(configured) {
  const homes = [];
  const push = (value) => {
    if (!value || typeof value !== 'string') return;
    const full = resolve(value);
    if (!homes.includes(full)) homes.push(full);
  };
  if (Array.isArray(configured)) for (const home of configured) push(home);
  push(process.env.DSH_HOME);
  push(join(homedir(), '.dsh'));
  const legacy = join(homedir(), '.dsh_desktop');
  try {
    if (existsSync(legacy)) {
      for (const entry of readdirSync(legacy, { withFileTypes: true })) {
        if (entry.isDirectory()) push(join(legacy, entry.name));
      }
    }
  } catch { /* legacy tree is optional */ }
  return homes.filter((home) => existsSync(join(home, 'sessions')));
}

/** Decode a session directory name such as --Users-d-Foo-- into a path-ish label. */
export function decodeWorkspaceName(name) {
  if (typeof name !== 'string' || name.length === 0) return name || '';
  let inner = name;
  if (inner.startsWith('--')) inner = inner.slice(2);
  if (inner.endsWith('--')) inner = inner.slice(0, -2);
  inner = inner.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const segments = inner.split('-').filter(Boolean);
  return segments.length > 0 ? '/' + segments.join('/') : name;
}
