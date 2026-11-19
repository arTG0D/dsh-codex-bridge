import { stat } from 'node:fs/promises';
import { convertThread } from './convert.js';
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
            summary.skipped.push({ threadId: thread.id, title: thread.title, sessionId: recorded.sessionId });
          }
          continue;
        }
        try {
          const outcome = await this.#importThread({ store, thread, session, dryRun, signal: options.signal });
          if (outcome === undefined) summary.skipped.push({ threadId: thread.id, title: thread.title, sessionId: '' });
          else summary.imported.push(outcome);
        } catch (error) {
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

  async #importThread({ store, thread, session, dryRun, signal }) {
    const cwd = normalizePath(thread.cwd);
    if (cwd.length === 0 || !(await isDirectory(cwd))) {
      throw new Error(`working directory does not exist: ${cwd || '(empty)'}`);
    }
    const turns = store.listTurns(thread.id);
    const items = store.listItems(thread.id);
    const conversion = convertThread({ thread, turns, items, maxTitleBytes: 200 });

    if (dryRun) {
      return {
        threadId: thread.id,
        title: conversion.title || thread.title,
        sessionId: '',
        events: conversion.events.length,
        turns: turns.length,
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
    });
    return {
      threadId: thread.id,
      title: conversion.title || thread.title,
      sessionId: String(id),
      events: conversion.events.length,
      turns: turns.length,
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
    // specifier does not resolve. Fall back to the installation anchor the Host exposes.
    try {
      return await import('@deepseek-ai/dsh-session');
    } catch {
      // Fall through to the anchored resolution.
    }
    const installDir = process.env.DSH_INSTALL_DIR;
    if (typeof installDir !== 'string' || installDir.length === 0) {
      throw new Error(
        'the Harness session package is not resolvable: DSH_INSTALL_DIR is unset and the bare specifier failed',
      );
    }
    try {
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const { join } = await import('node:path');
      const anchor = pathToFileURL(join(installDir, 'package.json')).href;
      const entry = createRequire(anchor).resolve('@deepseek-ai/dsh-session');
      return await import(pathToFileURL(entry).href);
    } catch (error) {
      throw new Error(`the Harness session package is not resolvable from ${installDir}: ${errorText(error)}`);
    }
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

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
