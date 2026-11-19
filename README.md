# dsh-codex-bridge

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that imports Codex Desktop conversations as Harness sessions and keeps user skills in sync both ways.

[中文说明](README.zh.md)

## Why

Codex Desktop and DeepSeek Harness are both good places to work, but they keep separate histories. This bundle makes the Codex history usable from the Harness, and keeps the skill libraries from drifting apart.

## What it does

- **Sessions:** every Codex thread in the SQLite history becomes one Harness Session, attached to a Workspace for its original `cwd`. User message, assistant text, reasoning, and recorded tool activity are preserved, so the imported session continues where Codex left off.
- **Skills:** `~/.codex/skills` is mounted as a Harness skill provider (read live, nothing copied), and a mirror copies skills that exist on only one side between `~/.codex/skills` and `~/.dsh/skills`. A skill that differs on both sides is reported, never silently replaced.

## Requirements

- DeepSeek Harness `0.2.2-rc.5` or newer in the `0.2.x` line.
- Codex Desktop whose conversation history lives in `~/.codex/state_5.sqlite` and `~/.codex/thread_history_1.sqlite`. Older Codex builds that only wrote `sessions/**/rollout-*.jsonl` are not read.

## Install

From the Harness **Plugins** page, add this directory as a local bundle, or copy the folder into the profile and add it:

```yaml
# profile cordis.patch.yml
- insert:
    - id: codex-bridge
      name: dsh-codex-bridge
      config:
        importSessions:
          enabled: true
          onStart: true
          watch: true
          intervalSeconds: 60
        syncSkills:
          enabled: true
          watch: true
          overwrite: false
```

## Commands

| Command | Effect |
|---|---|
| `/codex-status` | Imported counts, pending threads, mirror conflicts, last error |
| `/codex-import` | Import now; `--dry-run` lists the plan |
| `/codex-skill-sync` | Mirror now; `--force` lets the newest copy of a conflict win |

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `codexHome` | `$CODEX_HOME` or `~/.codex` | Codex home directory |
| `importSessions.enabled` | `true` | Import Codex threads at all |
| `importSessions.onStart` | `true` | Run one import shortly after the Host boots |
| `importSessions.watch` | `true` | Repeat the import on an interval |
| `importSessions.intervalSeconds` | `60` | Interval between background imports; `0` disables the timer |
| `importSessions.maxThreads` | `100` | Most recent threads examined per run |
| `importSessions.includeArchived` | `false` | Whether archived Codex threads are imported |
| `syncSkills.enabled` | `true` | Mount the provider and run the mirror |
| `syncSkills.watch` | `true` | Re-run the mirror when either skill root changes |
| `syncSkills.includeSystem` | `false` | Include Codex's reserved `.system` skills |
| `syncSkills.overwrite` | `false` | Let the newest copy of a conflicted skill win automatically |

## How the import writes sessions

The importer follows the same path the official DeepSeek chat export importer uses:

1. `convertThread()` turns one Codex thread into seed events — `turn/start`, `step/start`, `user/message`, `assistant/message`, `tool/call`/`tool/result`, `step/end`, `turn/end`.
2. `Session.create()` validates the whole seed log, exactly as a live session would.
3. `sessionPersistence.create()` writes it, then the projection cache is refreshed and the Session is attached to its Workspace.

Writing the log by hand would skip that validation and produce sessions the token meter refuses to replay, which is the failure mode older bridges had to repair afterwards.

## Limits

- Import is one-shot per thread. Continuing a Codex thread after import is reported by `/codex-status` but not appended.
- Exporting Harness sessions back to Codex is not implemented yet.
- Imported tool calls are history only; they are not callable tools in the Harness.
- `~/.agents/skills` is intentionally not mirrored: both products already read it.

## License

MIT
