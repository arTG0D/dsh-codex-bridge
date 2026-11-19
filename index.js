import { watch } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeConfig } from './src/config.js';
import { resolveCodexHome, resolveDshHome } from './src/paths.js';
import { BridgeState } from './src/state.js';
import { SessionImporter, errorText } from './src/importer.js';
import { CodexSkillProvider, SkillMirror, ensureSkillRoot } from './src/skills.js';

/** Services this bundle needs before it can activate; a profile without them leaves the plugin off. */
export const inject = ['sessionPersistence', 'sessionProjectionCache', 'workspaceRegistry', 'skills', 'commands'];

/** Debounce applied to filesystem notifications, which arrive in bursts on Windows. */
const WATCH_DEBOUNCE_MS = 2_500;

/**
 * Entry point of the bundle: starts the background import and the skill mirror.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's own Cordis context.
 * @param {unknown} rawConfig - the `config` block of this bundle's loader row.
 */
export async function apply(ctx, rawConfig) {
  const normalized = normalizeConfig(rawConfig);
  const config = { ...normalized, codexHome: resolveCodexHome(normalized.codexHome) };
  const dshHome = resolveDshHome();
  const log = createLogger(ctx);

  let state;
  try {
    state = await BridgeState.load(dshHome);
  } catch (error) {
    log.error(`codex-bridge: cannot read its state file: ${errorText(error)}`);
    return;
  }

  // A boot marker makes "did the new module generation actually load, and did the
  // background work start" answerable from outside the process.
  const diagnosticsPath = join(dshHome, 'codex-bridge', 'last-run.json');
  const writeDiagnostics = async (payload) => {
    try {
      await mkdir(join(dshHome, 'codex-bridge'), { recursive: true });
      await writeFile(diagnosticsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch {
      // Diagnostics are best effort; the plugin keeps working without them.
    }
  };
  await writeDiagnostics({ event: 'boot', at: new Date().toISOString(), version: BRIDGE_VERSION, codexHome: config.codexHome });

  const status = {
    lastImport: null,
    lastImportAt: 0,
    lastSkillSync: null,
    lastSkillSyncAt: 0,
    lastError: '',
  };

  const importer = config.importSessions.enabled
    ? new SessionImporter(ctx, config, state, log)
    : undefined;

  const runImport = async (options = {}) => {
    if (importer === undefined) {
      return { skipped: true, reason: 'session import is disabled by configuration' };
    }
    if (runImport.running === true) {
      return { skipped: true, reason: 'an import is already running' };
    }
    runImport.running = true;
    try {
      const summary = await importer.run(options);
      status.lastImport = summary;
      status.lastImportAt = Date.now();
      if (summary.failed.length > 0) {
        status.lastError = summary.failed.map((entry) => `${entry.threadId}: ${entry.reason}`).join('; ');
      }
      await writeDiagnostics({ event: 'import', at: new Date().toISOString(), dryRun: options.dryRun === true, summary });
      return summary;
    } catch (error) {
      status.lastError = errorText(error);
      log.warn(`codex-bridge: import failed: ${status.lastError}`);
      await writeDiagnostics({ event: 'import', at: new Date().toISOString(), error: status.lastError });
      return { error: status.lastError };
    } finally {
      runImport.running = false;
    }
  };

  const roots = {
    codex: join(config.codexHome, 'skills'),
    dsh: join(dshHome, 'skills'),
  };
  const mirror = config.syncSkills.enabled
    ? new SkillMirror({ roots, config, state, log })
    : undefined;

  const runSkillSync = async (options = {}) => {
    if (mirror === undefined) return { skipped: true, reason: 'skill sync is disabled by configuration' };
    if (runSkillSync.running === true) return { skipped: true, reason: 'a skill sync is already running' };
    runSkillSync.running = true;
    try {
      const result = await mirror.sync(options);
      status.lastSkillSync = result;
      status.lastSkillSyncAt = Date.now();
      await writeDiagnostics({ event: 'skill-sync', at: new Date().toISOString(), result });
      return result;
    } catch (error) {
      status.lastError = errorText(error);
      log.warn(`codex-bridge: skill sync failed: ${status.lastError}`);
      await writeDiagnostics({ event: 'skill-sync', at: new Date().toISOString(), error: status.lastError });
      return { error: status.lastError };
    } finally {
      runSkillSync.running = false;
    }
  };

  if (config.syncSkills.enabled) {
    // A provider over the Codex root makes those skills first-class Harness skills
    // without copying anything, so an edit on either side is live. It reads the
    // reserved `.system` directory too: mounting is additive and read-only, while
    // copying those bundled skills into the user root is not.
    ctx.effect(() => ctx.skills.registerProvider(
      () => new CodexSkillProvider([roots.codex], { includeSystem: true }),
    ));
    try {
      await ensureSkillRoot(roots.dsh);
    } catch {
      // The mirror reports the failure when it runs.
    }
  }

  if (config.importSessions.watch && config.importSessions.intervalSeconds > 0) {
    const intervalMs = config.importSessions.intervalSeconds * 1000;
    ctx.effect(() => {
      const timer = setInterval(() => {
        void runImport();
      }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  }

  if (config.syncSkills.watch) {
    ctx.effect(() => {
      const disposers = [roots.codex, roots.dsh].map((root) => debounceWatch(root, () => void runSkillSync()));
      return () => {
        for (const dispose of disposers) dispose();
      };
    });
  }

  ctx.effect(() => ctx.commands.register({
    name: 'codex-status',
    description: 'Report Codex bridge state: imported sessions, pending threads, and skill mirror conflicts.',
    handler: async () => ({ kind: 'success', text: await statusText() }),
  }));

  ctx.effect(() => ctx.commands.register({
    name: 'codex-import',
    description: 'Import Codex threads now. Pass --dry-run to list what would be imported.',
    handler: async (invocation) => {
      const dryRun = String(invocation?.rawInput ?? '').includes('--dry-run');
      const summary = await runImport({ dryRun });
      return { kind: 'success', text: importText(summary, dryRun) };
    },
  }));

  ctx.effect(() => ctx.commands.register({
    name: 'codex-skill-sync',
    description: 'Mirror skills between Codex and the Harness now. Pass --force to let the newest copy win.',
    handler: async (invocation) => {
      const force = String(invocation?.rawInput ?? '').includes('--force');
      const result = await runSkillSync({ force });
      return { kind: 'success', text: skillText(result) };
    },
  }));

  const statusText = async () => {
    const summary = status.lastImport;
    const lines = [
      `codex-bridge ${BRIDGE_VERSION}`,
      `codex home: ${config.codexHome}`,
      `import: ${config.importSessions.enabled ? 'on' : 'off'}${config.importSessions.watch ? ` (every ${config.importSessions.intervalSeconds}s)` : ' (manual)'}`,
      `skills: ${config.syncSkills.enabled ? 'on' : 'off'}${config.syncSkills.watch ? ' (watching)' : ' (manual)'}`,
      `imported threads (recorded): ${Object.keys(state.sessions).length}`,
    ];
    if (summary !== null && summary !== undefined && summary.imported !== undefined) {
      lines.push(
        `last import: ${summary.imported.length} imported, ${summary.skipped.length} already imported, ` +
          `${summary.failed.length} failed, ${summary.stale.length} changed since import`,
      );
    } else if (status.lastImportAt === 0) {
      lines.push('last import: not run yet in this process');
    }
    if (status.lastSkillSync !== null && status.lastSkillSync !== undefined && status.lastSkillSync.copied !== undefined) {
      lines.push(
        `last skill sync: ${status.lastSkillSync.copied.length} copied, ` +
          `${status.lastSkillSync.conflicts.length} conflict(s), ${status.lastSkillSync.failed.length} failed`,
      );
    }
    if (status.lastError.length > 0) lines.push(`last error: ${status.lastError}`);
    return lines.join('\n');
  };

  if (config.importSessions.enabled && config.importSessions.onStart) {
    // Let the Host finish booting before touching the session store.
    ctx.effect(() => {
      const timer = setTimeout(() => {
        void runImport();
      }, 4_000);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  }

  log.info(`codex-bridge ${BRIDGE_VERSION} active (codex home: ${config.codexHome})`);
}

const BRIDGE_VERSION = '0.1.0';

function createLogger(ctx) {
  const fallback = (level) => (message) => {
    const line = String(message);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  const logger = ctx.logger;
  return {
    info: typeof logger?.info === 'function' ? (message) => logger.info(message) : fallback('info'),
    warn: typeof logger?.warn === 'function' ? (message) => logger.warn(message) : fallback('warn'),
    error: typeof logger?.error === 'function' ? (message) => logger.error(message) : fallback('error'),
  };
}

/** Watch one directory non-recursively and coalesce bursts into a single callback. */
function debounceWatch(root, callback) {
  let timer;
  let watcher;
  try {
    watcher = watch(root, { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(callback, WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', () => {
      // A removed root ends watching; the interval timer still covers sessions.
      watcher.close();
    });
  } catch {
    return () => {};
  }
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

function importText(summary, dryRun) {
  if (summary === undefined || summary === null) return 'codex-bridge: no result';
  if (summary.error !== undefined) return `codex-bridge: import failed: ${summary.error}`;
  if (summary.skipped === true) return `codex-bridge: ${summary.reason}`;
  const lines = [
    dryRun
      ? `codex-bridge dry run: ${summary.imported.length} thread(s) would be imported`
      : `codex-bridge: imported ${summary.imported.length} thread(s)`,
    `already imported: ${summary.skipped.length}`,
    `changed since import: ${summary.stale.length}`,
    `failed: ${summary.failed.length}`,
  ];
  for (const entry of summary.imported.slice(0, 10)) {
    const note = entry.cwdAdjusted === true ? ' (original folder missing; used its nearest parent)' : '';
    lines.push(`  + ${entry.title} (${entry.turns} turns, ${entry.events} events) → ${entry.sessionId || 'dry run'}${note}`);
  }
  for (const entry of summary.stale.slice(0, 10)) {
    lines.push(`  ~ ${entry.title} changed in Codex after import; re-import is not automatic`);
  }
  for (const entry of summary.failed.slice(0, 10)) {
    lines.push(`  ! ${entry.title || entry.threadId}: ${entry.reason}`);
  }
  return lines.join('\n');
}

function skillText(result) {
  if (result === undefined || result === null) return 'codex-bridge: no result';
  if (result.error !== undefined) return `codex-bridge: skill sync failed: ${result.error}`;
  if (result.skipped === true) return `codex-bridge: ${result.reason}`;
  const lines = [
    `codex-bridge skill sync: ${result.copied.length} copied, ${result.conflicts.length} conflict(s), ${result.unchanged.length} unchanged, ${result.failed.length} failed`,
  ];
  for (const entry of result.copied.slice(0, 20)) lines.push(`  + ${entry.name} (${entry.direction}${entry.forced === true ? ', forced' : ''})`);
  for (const entry of result.conflicts.slice(0, 20)) lines.push(`  ! ${entry.name}: both sides differ; rerun with --force to let the newest win`);
  for (const entry of result.failed.slice(0, 20)) lines.push(`  x ${entry.name}: ${entry.reason}`);
  return lines.join('\n');
}
