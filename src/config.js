/** Defaults for every accepted configuration field; users override them in `cordis.patch.yml`. */
export const DEFAULT_CONFIG = Object.freeze({
  codexHome: '',
  importSessions: Object.freeze({
    enabled: true,
    onStart: true,
    watch: true,
    intervalSeconds: 60,
    maxThreads: 100,
    includeArchived: false,
  }),
  syncSkills: Object.freeze({
    enabled: true,
    watch: true,
    includeSystem: false,
    overwrite: false,
  }),
});

function number(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function text(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Merge one loader row's configuration over the defaults, ignoring fields of the wrong type.
 * @param {unknown} raw - the `config` value the loader handed to `apply`.
 * @returns a complete, validated configuration object.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const sessions = input.importSessions !== null && typeof input.importSessions === 'object' ? input.importSessions : {};
  const skills = input.syncSkills !== null && typeof input.syncSkills === 'object' ? input.syncSkills : {};
  const sessionDefaults = DEFAULT_CONFIG.importSessions;
  const skillDefaults = DEFAULT_CONFIG.syncSkills;
  return {
    codexHome: text(input.codexHome, DEFAULT_CONFIG.codexHome),
    importSessions: {
      enabled: flag(sessions.enabled, sessionDefaults.enabled),
      onStart: flag(sessions.onStart, sessionDefaults.onStart),
      watch: flag(sessions.watch, sessionDefaults.watch),
      intervalSeconds: number(sessions.intervalSeconds, sessionDefaults.intervalSeconds, 0, 86_400),
      maxThreads: number(sessions.maxThreads, sessionDefaults.maxThreads, 1, 5_000),
      includeArchived: flag(sessions.includeArchived, sessionDefaults.includeArchived),
    },
    syncSkills: {
      enabled: flag(skills.enabled, skillDefaults.enabled),
      watch: flag(skills.watch, skillDefaults.watch),
      includeSystem: flag(skills.includeSystem, skillDefaults.includeSystem),
      overwrite: flag(skills.overwrite, skillDefaults.overwrite),
    },
  };
}
