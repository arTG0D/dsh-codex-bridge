import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { convertThread, NoImportableTurnError } from './convert.js';
import { CodexStore } from './codex-store.js';
import { normalizePath, pathKey } from './paths.js';

/**
 * Writes Codex threads into the Harness session store.
 *
 * A Session is created through `Session.create` (which runs the same seed
 * validation a live Session runs), then persisted, then exposed to the Session
 * list projection, then attached to its Workspace. Writing the log by hand would
 * skip every one of those checks and produce sessions the token meter refuses to
 * replay — which is exactly the failure the previous Codex bridge had to repair
 * after the fact.
 */
export class SessionImporter {
  #ctx;
  #config;
  #state;
  #log;

  constructor(ctx, config, state, log) {
    this.#ctx = ctx;
    this.#config = config;
    this.#state = state;
    this.#log = log;
  }

  /**
   * Import every thread that has not been imported yet.
   * @param {{ dryRun?: boolean, signal?: AbortSignal }} options - plan-only mode and cancellation.
   */
  async run(options = {}) {
    const dryRun = options.dryRun === true;
    const summary = { imported: [], skipped: [], failed: [], stale: [] };
    const session = await this.#loadSessionModule();
    let store;
    try {
      store = await CodexStore.open(this.#config.codexHome);
    } catch (error) {
      summary.failed.push({ threadId: '', title: '', reason: errorText(error) });
      return summary;
    }
    try {
      const threads = store.listThreads({ includeArchived: this.#config.importSessions.includeArchived });
      const limit = this.#config.importSessions.maxThreads;
      const selected = threads.slice(-limit);
      for (const thread of selected) {
        if (options.signal?.aborted === true) break;
        const recorded = this.#state.session(thread.id);
        if (recorded !== undefined) {
          const highest = store.highestOrdinal(thread.id);
          if (highest > (recorded.lastOrdinal ?? 0)) {
            summary.stale.push({ threadId: thread.id, title: thread.title, sessionId: recorded.sessionId });
          } else {
            summary.skipped.push({ threadId: thread.id, title: thread.title, sessionId: recorded.sessionId, reason: 'already imported' });
          }
          continue;
        }
        try {
          const items = store.listItems(thread.id);
          if (items.length === 0) {
            // A thread Codex created but never wrote an item to has nothing to import.
            summary.skipped.push({ threadId: thread.id, title: thread.title, sessionId: '', reason: 'no recorded items' });
            continue;
          }
          const outcome = await this.#importThread({ store, thread, items, session, dryRun, signal: options.signal });
          if (outcome === undefined) {
            summary.skipped.push({ threadId: thread.id, title: thread.title, sessionId: '', reason: 'nothing model-visible' });
          } else {
            summary.imported.push(outcome);
          }
        } catch (error) {
          if (error instanceof NoImportableTurnError) {
            summary.skipped.push({ threadId: thread.id, title: thread.title, sessionId: '', reason: error.message });
            continue;
          }
          this.#log.warn(`codex-bridge: thread ${thread.id} was not imported: ${errorText(error)}`);
          summary.failed.push({ threadId: thread.id, title: thread.title, reason: errorText(error) });
        }
      }
    } finally {
      store.close();
    }
    if (!dryRun && summary.imported.length > 0) {
      await this.#state.save();
      this.#log.info(`codex-bridge: imported ${summary.imported.length} Codex thread(s)`);
    }
    return summary;
  }

  async #importThread({ store, thread, items, session, dryRun, signal }) {
    const resolved = await resolveWorkingDirectory(thread.cwd);
    const cwd = resolved.path;
    const turns = store.listTurns(thread.id);
    const conversion = convertThread({ thread, turns, items, maxTitleBytes: 200 });

    if (dryRun) {
      return {
        threadId: thread.id,
        title: conversion.title || thread.title,
        sessionId: '',
        events: conversion.events.length,
        turns: turns.length,
        cwdAdjusted: resolved.adjusted,
      };
    }

    const { Session, SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } = session;
    const id = SessionId(randomId());
    const header = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: conversion.createdAt,
      cwd,
      isSeeded: false,
    };
    // Construction runs the same seed validation as a live Session; the detached instance is discarded.
    Session.create(id, conversion.events, header);
    signal?.throwIfAborted?.();

    const handle = await this.#ctx.sessionPersistence.create(header, signal === undefined ? {} : { signal });
    try {
      await handle.append(conversion.events);
      await handle.flush();
    } finally {
      await handle.close();
    }
    this.#projectionCache?.coldSnapshot?.(header, SessionLogOffset(0), conversion.events);

    let workspaceAttached = false;
    try {
      const workspace = await this.#resolveWorkspace(cwd);
      if (workspace !== undefined && typeof workspace.attachSession === 'function') {
        await workspace.attachSession(id);
        workspaceAttached = true;
      }
    } catch (error) {
      this.#log.warn(`codex-bridge: session ${id} was stored but not added to its workspace: ${errorText(error)}`);
    }

    this.#state.recordSession(thread.id, {
      sessionId: String(id),
      lastOrdinal: store.highestOrdinal(thread.id),
      importedAt: Date.now(),
      cwd,
      title: conversion.title || thread.title,
      workspaceAttached,
      ...(resolved.adjusted ? { requestedCwd: normalizePath(thread.cwd) } : {}),
    });
    return {
      threadId: thread.id,
      title: conversion.title || thread.title,
      sessionId: String(id),
      events: conversion.events.length,
      turns: turns.length,
      cwdAdjusted: resolved.adjusted,
    };
  }

  get #projectionCache() {
    return this.#ctx.sessionProjectionCache;
  }

  async #resolveWorkspace(cwd) {
    const registry = this.#ctx.workspaceRegistry;
    const key = pathKey(cwd);
    let match;
    for (const workspace of registry.list()) {
      if (pathKey(workspace.path) === key) {
        match = workspace;
        break;
      }
    }
    if (match !== undefined) return match;
    if (typeof registry.create !== 'function') return undefined;
    return registry.create(cwd);
  }

  async #loadSessionModule() {
    // A profile-installed bundle lives outside the Harness installation, so a bare
    // specifier does not resolve and the Host process does not export
    // DSH_INSTALL_DIR to its own modules. Anchor on the installation instead.
    try {
      return await import('@deepseek-ai/dsh-session');
    } catch {
      // Fall through to the anchored resolution.
    }
    const attempts = [];
    for (const directory of installCandidates()) {
      try {
        const anchor = pathToFileURL(join(directory, 'package.json')).href;
        const entry = createRequire(anchor).resolve('@deepseek-ai/dsh-session');
        return await import(pathToFileURL(entry).href);
      } catch (error) {
        attempts.push(`${directory}: ${errorText(error)}`);
      }
    }
    throw new Error(
      `the Harness session package is not resolvable; tried:\n  ${attempts.join('\n  ')}`,
    );
  }
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory an imported Session runs in. Codex keeps a thread's original `cwd`,
 * which may have been deleted or renamed since; walking up to the nearest existing
 * ancestor keeps the conversation instead of dropping it over a missing folder.
 * @param {string} rawCwd - the `cwd` Codex recorded.
 * @returns {{ path: string, adjusted: boolean }}
 */
async function resolveWorkingDirectory(rawCwd) {
  const requested = normalizePath(rawCwd);
  if (requested.length > 0 && (await isDirectory(requested))) {
    return { path: requested, adjusted: false };
  }
  let candidate = requested;
  while (candidate.length > 0) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
    if (candidate.length > 0 && (await isDirectory(candidate))) {
      return { path: candidate, adjusted: true };
    }
  }
  const home = homedir();
  return { path: home, adjusted: true };
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Candidate directories that contain the installed `@deepseek-ai/dsh` package, in
 * the order they are most likely to be right: an explicit export, the Electron
 * resources root, a sibling `resources/app.asar` layout, then plain npm layouts.
 */
function installCandidates() {
  const candidates = [];
  const push = (path) => {
    if (typeof path === 'string' && path.length > 0 && !candidates.includes(path)) candidates.push(path);
  };
  push(process.env.DSH_INSTALL_DIR);
  const resources = process.resourcesPath;
  if (typeof resources === 'string' && resources.length > 0) {
    push(join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
    push(join(resources, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  const executableDir = dirname(process.execPath);
  push(join(executableDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
  push(join(executableDir, 'node_modules', '@deepseek-ai', 'dsh'));
  push(join(executableDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  return candidates;
}

/** Test hook: the anchors the importer would try in this process. */
export function describeInstallCandidates() {
  return installCandidates();
}
