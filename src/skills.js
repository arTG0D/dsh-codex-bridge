import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Codex skills exposed to the Harness as a first-class provider, plus the mirror
 * that keeps the two user skill roots in step.
 *
 * The shared `~/.agents/skills` root is deliberately not touched: both products
 * already read it, so mirroring it would only create duplicate work and races.
 */

/** Rank of this provider in the merged catalog: after `user-dsh` (400), before `user-agents` (500). */
const CODEX_RANK = 450;

/** Directory name Codex reserves for its own bundled skills. */
const SYSTEM_DIR = '.system';

/**
 * Skill provider over a Codex skills root.
 * Discovery parses frontmatter only; every `get()` re-reads the current file, so
 * editing a skill body needs no cache invalidation.
 */
export class CodexSkillProvider {
  #roots;
  #includeSystem;

  constructor(roots, options = {}) {
    this.name = 'codex-skills';
    this.#roots = roots;
    this.#includeSystem = options.includeSystem === true;
  }

  async list(options = {}) {
    const signal = options?.signal;
    const candidates = [];
    for (const root of this.#roots) {
      signal?.throwIfAborted?.();
      await this.#collect(root, candidates, signal);
    }
    return { candidates, complete: true };
  }

  /** Collect skills from one root; the reserved `.system` directory holds its own skills one level down. */
  async #collect(root, candidates, signal) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      signal?.throwIfAborted?.();
      const full = join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === SYSTEM_DIR) {
          if (this.#includeSystem) await this.#collect(full, candidates, signal);
          continue;
        }
        const parsed = await tryParse(join(full, 'SKILL.md'));
        if (parsed !== undefined) candidates.push(candidateOf(parsed, join(full, 'SKILL.md')));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const parsed = await tryParse(full);
        if (parsed !== undefined) candidates.push(candidateOf(parsed, full));
      }
    }
  }

  async get(candidate) {
    const locator = candidate?.locator;
    if (typeof locator !== 'string') return undefined;
    const parsed = await tryParse(locator);
    if (parsed === undefined) return undefined;
    return {
      ...candidateOf(parsed, locator),
      content: parsed.body,
    };
  }
}

function candidateOf(parsed, path) {
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
    ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
    path,
    invocation: {
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
    },
    source: 'codex',
    provider: 'codex-skills',
    rank: CODEX_RANK,
    locator: path,
    resourceBase: { kind: 'directory', path: dirnameOf(path) },
  };
}

function dirnameOf(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index <= 0 ? path : path.slice(0, index);
}

async function tryParse(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseSkillDocument(text);
  } catch {
    return undefined;
  }
}

/**
 * Parse a SKILL.md document into frontmatter fields and its Markdown body.
 * @param {string} text - complete file contents.
 */
export function parseSkillDocument(text) {
  const normalized = text.replace(/^\uFEFF/u, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(normalized);
  if (match === null) throw new Error('missing frontmatter');
  const front = parseFrontmatter(match[1]);
  const name = stringField(front.name);
  const description = stringField(front.description);
  if (name === undefined || description === undefined) throw new Error('frontmatter lacks name or description');
  const body = normalized.slice(match[0].length).trim();
  return {
    name,
    description,
    whenToUse: stringField(front.when_to_use ?? front.whenToUse) ?? (front.metadata !== null && typeof front.metadata === 'object' ? stringField(front.metadata['short-description']) : undefined),
    metadata: front.metadata !== null && typeof front.metadata === 'object' ? front.metadata : undefined,
    modelInvocable: booleanField(front['disable-model-invocation']) !== true,
    userInvocable: booleanField(front['user-invocable']) !== false,
    body,
  };
}

/** A YAML subset: `key: value` lines plus one level of nested `key:` blocks. */
function parseFrontmatter(source) {
  const result = {};
  let parent = null;
  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith('#')) continue;
    const indented = /^\s+/u.test(rawLine);
    const line = rawLine.trim();
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1).trim();
    if (!indented) {
      if (rest.length === 0) {
        result[key] = {};
        parent = key;
      } else {
        result[key] = unquote(rest);
        parent = null;
      }
      continue;
    }
    if (parent !== null && result[parent] !== null && typeof result[parent] === 'object') {
      result[parent][key] = unquote(rest);
    }
  }
  return result;
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\"/gu, '"');
    }
  }
  return value;
}

function stringField(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function booleanField(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  return undefined;
}

/**
 * Two-way mirror between the Codex user skill root and the Harness user skill root.
 *
 * A skill that exists on only one side is copied to the other. A skill that exists
 * on both sides with different contents is a conflict: reported, never silently
 * overwritten unless the caller asks for the newest copy to win, and the replaced
 * directory is kept as a timestamped backup.
 */
export class SkillMirror {
  #roots;
  #config;
  #state;
  #log;

  constructor({ roots, config, state, log }) {
    this.#roots = roots;
    this.#config = config;
    this.#state = state;
    this.#log = log;
  }

  async sync(options = {}) {
    const force = options.force === true || this.#config.syncSkills.overwrite === true;
    const result = { copied: [], conflicts: [], unchanged: [], failed: [] };
    const [codexSkills, dshSkills] = await Promise.all([
      this.#scan(this.#roots.codex),
      this.#scan(this.#roots.dsh),
    ]);
    const names = new Set([...codexSkills.keys(), ...dshSkills.keys()]);
    for (const name of [...names].sort()) {
      const codex = codexSkills.get(name);
      const dsh = dshSkills.get(name);
      try {
        if (codex !== undefined && dsh === undefined) {
          await this.#copy(codex.dir, join(this.#roots.dsh, name));
          result.copied.push({ name, direction: 'codex-to-dsh' });
        } else if (codex === undefined && dsh !== undefined) {
          await this.#copy(dsh.dir, join(this.#roots.codex, name));
          result.copied.push({ name, direction: 'dsh-to-codex' });
        } else if (codex !== undefined && dsh !== undefined) {
          if (codex.hash === dsh.hash) {
            result.unchanged.push({ name });
            continue;
          }
          if (!force) {
            result.conflicts.push({ name, codex: codex.dir, dsh: dsh.dir });
            continue;
          }
          const [codexTime, dshTime] = await Promise.all([mtimeOf(codex.dir), mtimeOf(dsh.dir)]);
          const winner = codexTime >= dshTime ? 'codex' : 'dsh';
          const source = winner === 'codex' ? codex : dsh;
          const target = winner === 'codex' ? join(this.#roots.dsh, name) : join(this.#roots.codex, name);
          await this.#backup(target, name);
          await this.#copy(source.dir, target);
          result.copied.push({ name, direction: winner === 'codex' ? 'codex-to-dsh' : 'dsh-to-codex', forced: true });
        }
        const record = this.#state.skill(name) ?? {};
        this.#state.recordSkill(name, { ...record, lastSyncedAt: Date.now() });
      } catch (error) {
        this.#log.warn(`codex-bridge: skill ${name} was not mirrored: ${error instanceof Error ? error.message : String(error)}`);
        result.failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (result.copied.length > 0) await this.#state.save();
    return result;
  }

  async #scan(root) {
    const found = new Map();
    await this.#scanFlat(root, found);
    if (this.#config.syncSkills.includeSystem) {
      // `.system` is a container of Codex's own skills, one level deeper than the root.
      await this.#scanFlat(join(root, SYSTEM_DIR), found);
    }
    return found;
  }

  /** Record every directory of one flat root that holds a `SKILL.md`. */
  async #scanFlat(dir, found) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === SYSTEM_DIR) continue;
      const skillDir = join(dir, entry.name);
      try {
        await stat(join(skillDir, 'SKILL.md'));
      } catch {
        continue;
      }
      found.set(entry.name, { dir: skillDir, hash: await hashDirectory(skillDir) });
    }
  }

  async #copy(source, target) {
    await mkdir(dirnameOf(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }

  async #backup(target, name) {
    try {
      await stat(target);
    } catch {
      return;
    }
    const backup = `${target}.bak-${Date.now()}`;
    await rename(target, backup);
    this.#log.info(`codex-bridge: kept the replaced skill ${name} as ${backup}`);
  }
}

/** Content hash of a skill directory: every file's relative path and bytes, sorted by path. */
async function hashDirectory(dir) {
  const digest = createHash('sha256');
  const files = [];
  const walk = async (current, prefix) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) files.push({ relative, full });
    }
  };
  await walk(dir, '');
  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  for (const file of files) {
    digest.update(file.relative);
    digest.update('\u0000');
    digest.update(await readFile(file.full));
    digest.update('\u0000');
  }
  return digest.digest('hex');
}

async function mtimeOf(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Write a small marker so a fresh mirror run can tell an empty root from a missing one. */
export async function ensureSkillRoot(root) {
  await mkdir(root, { recursive: true });
}
