import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read-only access to the Codex Desktop conversation databases.
 *
 * Codex Desktop stores thread metadata in `state_5.sqlite` and the conversation
 * items themselves in `thread_history_1.sqlite`. Both are opened read-only and
 * never written: Codex owns them, and a second writer would corrupt its history.
 *
 * The schema is versioned by Codex, so every query degrades to a narrower column
 * list when a newer build renames or drops a field.
 */
export class CodexStore {
  #state;
  #history;

  constructor(state, history) {
    this.#state = state;
    this.#history = history;
  }

  static async open(codexHome) {
    const statePath = join(codexHome, 'state_5.sqlite');
    const historyPath = join(codexHome, 'thread_history_1.sqlite');
    if (!existsSync(statePath)) {
      throw new Error(`Codex state database not found at ${statePath}`);
    }
    if (!existsSync(historyPath)) {
      throw new Error(
        `Codex thread history database not found at ${historyPath}; ` +
          'this bridge supports Codex Desktop builds whose history lives in SQLite',
      );
    }
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch (error) {
      throw new Error(`the node:sqlite builtin is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const open = (path) => new DatabaseSync(path, { readOnly: true });
    return new CodexStore(open(statePath), open(historyPath));
  }

  close() {
    try {
      this.#state.close();
    } catch {
      // Closing a already-closed handle is not an error worth reporting.
    }
    try {
      this.#history.close();
    } catch {
      // Same.
    }
  }

  /**
   * Every Codex thread, newest activity last.
   * @param {{ includeArchived?: boolean }} options - whether archived threads are included.
   */
  listThreads(options = {}) {
    const rows = this.#query(
      this.#state,
      'select id, cwd, title, name, preview, created_at_ms, updated_at_ms, archived, cli_version, history_mode, model, model_provider, project_id from threads',
      'select id, cwd, title, created_at_ms, updated_at_ms, archived, cli_version from threads',
    );
    const threads = rows.map((row) => ({
      id: String(row.id),
      cwd: typeof row.cwd === 'string' ? row.cwd : '',
      title: firstText(row.name, row.title, row.preview) ?? 'Untitled Codex thread',
      createdAtMs: toMillis(row.created_at_ms, row.created_at),
      updatedAtMs: toMillis(row.updated_at_ms, row.updated_at),
      archived: Number(row.archived ?? 0) !== 0,
      cliVersion: typeof row.cli_version === 'string' ? row.cli_version : '',
      historyMode: typeof row.history_mode === 'string' ? row.history_mode : '',
      model: typeof row.model === 'string' ? row.model : '',
      modelProvider: typeof row.model_provider === 'string' ? row.model_provider : '',
      projectId: typeof row.project_id === 'string' ? row.project_id : '',
    }));
    const filtered = options.includeArchived === true ? threads : threads.filter((thread) => !thread.archived);
    return filtered.sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /** Turns of one thread, in rollout order. */
  listTurns(threadId) {
    const rows = this.#query(
      this.#history,
      'select turn_id, status, error_json, started_at, completed_at, duration_ms, rollout_ordinal from thread_turns where thread_id = ? order by rollout_ordinal',
      'select turn_id, status, started_at, completed_at, rollout_ordinal from thread_turns where thread_id = ? order by rollout_ordinal',
      [threadId],
    );
    return rows.map((row) => ({
      turnId: String(row.turn_id),
      status: typeof row.status === 'string' ? row.status : 'completed',
      error: typeof row.error_json === 'string' ? row.error_json : '',
      startedAtMs: toMillis(row.started_at),
      completedAtMs: toMillis(row.completed_at),
      ordinal: Number(row.rollout_ordinal ?? 0),
    }));
  }

  /** Conversation items of one thread, in rollout order. */
  listItems(threadId) {
    const rows = this.#query(
      this.#history,
      'select turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type from thread_items where thread_id = ? order by rollout_ordinal',
      'select turn_id, item_id, rollout_ordinal, created_at_ms, item_json from thread_items where thread_id = ? order by rollout_ordinal',
      [threadId],
    );
    const items = [];
    for (const row of rows) {
      let payload;
      try {
        payload = JSON.parse(String(row.item_json));
      } catch {
        continue;
      }
      const type = typeof row.item_type === 'string' && row.item_type.length > 0
        ? row.item_type
        : typeof payload?.type === 'string' ? payload.type : '';
      items.push({
        turnId: String(row.turn_id),
        itemId: String(row.item_id),
        ordinal: Number(row.rollout_ordinal ?? 0),
        createdAtMs: toMillis(row.created_at_ms),
        type,
        payload,
      });
    }
    return items;
  }

  /** Highest rollout ordinal of one thread, used to detect growth since an import. */
  highestOrdinal(threadId) {
    const row = this.#query(
      this.#history,
      'select max(rollout_ordinal) as ordinal from thread_items where thread_id = ?',
      undefined,
      [threadId],
    )[0];
    const value = Number(row?.ordinal ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  #query(db, primary, fallback, params = []) {
    try {
      return db.prepare(primary).all(...params);
    } catch (error) {
      if (fallback === undefined) throw error;
      return db.prepare(fallback).all(...params);
    }
  }
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Codex records epoch seconds in some columns and epoch milliseconds in others. */
function toMillis(value, fallbackSeconds) {
  const source = value ?? fallbackSeconds;
  const numeric = Number(source);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric > 1e11 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
}
