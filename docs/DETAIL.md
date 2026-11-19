# Codex bridge

Imports Codex Desktop conversations into DeepSeek Harness and keeps user skills in sync in both directions.

## What it does

- **Imports Codex threads as Harness sessions.** Every thread in Codex's SQLite history becomes one Session with its own Workspace, so you can open it in the Harness and keep talking. Each imported turn keeps the user message, assistant text, reasoning, and the tool activity Codex recorded.
- **Mirrors skills.** Codex-only skills are copied into the Harness user root, Harness-only skills into the Codex user root, and a skill that differs on both sides is reported as a conflict instead of being overwritten.
- **Exposes Codex skills directly.** The `~/.codex/skills` root is also mounted as a Harness skill provider, so a skill edited there is visible without waiting for a copy.

## Use

Nothing to configure: the bundle starts the import and the skill mirror as soon as it is enabled.

| Command | Effect |
|---|---|
| `/codex-status` | Imported counts, pending threads, skill mirror conflicts, last error |
| `/codex-import` | Import now; `--dry-run` lists what would be imported |
| `/codex-skill-sync` | Mirror skills now; `--force` lets the newest copy of a conflicted skill win |

Configuration lives in the profile's `cordis.patch.yml` under the `codex-bridge` row.

## Limits worth knowing

- **Codex Desktop with SQLite history only.** This build reads `state_5.sqlite` and `thread_history_1.sqlite`. Codex versions that still keep conversations only as `sessions/**/rollout-*.jsonl` are not read.
- **Import is one-way and one-shot per thread.** A thread already imported is never imported twice. If you continue a Codex thread after importing it, the Harness copy does not grow: `/codex-status` reports it as changed instead. Returning a Harness session to Codex is not implemented yet.
- **Imported messages are history, not live turns.** They replay into the model context and render as normal rows, but the model is not re-run for them.
- **Tool calls keep their Codex identity.** A recorded MCP call appears as `<server>__<tool>`, and a Codex file change as `codex_file_change`; those tools are not callable in the Harness, only visible in the transcript.
- **`~/.agents/skills` is not mirrored.** Codex and the Harness already read that shared root, so copying it would race with both.

## 中文

把 Codex 桌面版会话导入 DSH，并双向同步用户技能。

- **导入**：Codex 的每个线程变成一个 DSH 会话并挂到对应工作目录，导入后可直接续聊；保留用户消息、助手正文、推理和工具轨迹。
- **技能**：只在一侧的技能会复制到另一侧；两侧都不同时报冲突，不覆盖。
- **限制**：只支持 SQLite 存储的 Codex 桌面版；每个线程只导入一次，Codex 侧后续新增的内容不会自动追加；暂不支持把 DSH 会话导回 Codex；`~/.agents/skills` 因为两边都已读取，不做镜像。
