import { homedir } from 'node:os';
import { join } from 'node:path';

/** Windows long-path prefix and trailing separators that make two equal paths compare unequal. */
export function normalizePath(value) {
  if (typeof value !== 'string') return value;
  let path = value;
  if (path.startsWith('\\\\?\\')) path = path.slice(4);
  path = path.replace(/[\\/]+$/, '');
  return path;
}

/** Case-folded comparison key for a directory, so Windows paths match whichever way they were written. */
export function pathKey(value) {
  return normalizePath(value).replace(/\//g, '\\').toLowerCase();
}

/** The Codex home directory: config, skills, and the conversation databases. */
export function resolveCodexHome(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit.length > 0) return explicit;
  const fromEnv = process.env.CODEX_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(homedir(), '.codex');
}

/** The Harness home directory that owns this plugin's state and the user skill root. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(homedir(), '.dsh');
}
