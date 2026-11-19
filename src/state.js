import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Durable bookkeeping for this plugin: which Codex threads were imported, and what each
 * skill mirror last wrote. It is a derived cache — losing it only causes a re-check.
 */
export class BridgeState {
  #path;
  #data;

  constructor(path, data) {
    this.#path = path;
    this.#data = data;
  }

  static async load(dshHome) {
    const path = join(dshHome, 'codex-bridge', 'state.json');
    let data = { version: 1, sessions: {}, skills: {} };
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        data = {
          version: 1,
          sessions: parsed.sessions !== null && typeof parsed.sessions === 'object' ? parsed.sessions : {},
          skills: parsed.skills !== null && typeof parsed.skills === 'object' ? parsed.skills : {},
        };
      }
    } catch {
      // A missing or unreadable state file starts a fresh record.
    }
    return new BridgeState(path, data);
  }

  get sessions() {
    return this.#data.sessions;
  }

  get skills() {
    return this.#data.skills;
  }

  session(threadId) {
    return this.#data.sessions[threadId];
  }

  recordSession(threadId, entry) {
    this.#data.sessions[threadId] = entry;
  }

  skill(name) {
    return this.#data.skills[name];
  }

  recordSkill(name, entry) {
    this.#data.skills[name] = entry;
  }

  async save() {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#data, null, 2)}\n`, 'utf8');
    await rename(temporary, this.#path);
  }
}
