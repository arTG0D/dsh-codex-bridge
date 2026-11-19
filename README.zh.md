# dsh-codex-bridge

把 Codex 桌面版的会话导入 DeepSeek Harness，并双向同步用户技能。

[English](README.md)

## 为什么

Codex 桌面版和 DeepSeek Harness 都是顺手的工具，但两边的历史互不相通。这个 bundle 让 Codex 的历史能在 Harness 里接着用，也避免两边的技能库各自漂移。

## 做什么

- **会话**：Codex SQLite 历史里的每个线程变成一个 Harness 会话，挂到它原来 `cwd` 对应的工作区。用户消息、助手正文、推理和记录下来的工具活动都会保留，导入后可以直接续聊。
- **技能**：`~/.codex/skills` 作为 Harness 的技能 provider 实时挂载（不复制）；同时 `~/.codex/skills` 与 `~/.dsh/skills` 之间互为镜像，只在单侧存在的技能会被复制到另一侧。两侧内容不同时报冲突，不会静默覆盖。

## 要求

- DeepSeek Harness `0.2.2-rc.5` 及以上的 `0.2.x` 版本。
- Codex 桌面版，且会话历史位于 `~/.codex/state_5.sqlite` 与 `~/.codex/thread_history_1.sqlite`。只写 `sessions/**/rollout-*.jsonl` 的旧版 Codex 不在支持范围内。

## 安装

在 Harness 的**插件**页把本目录作为本地 bundle 添加；或放进 profile 后配置：

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

## 命令

| 命令 | 作用 |
|---|---|
| `/codex-status` | 已导入数量、待处理线程、镜像冲突、最近错误 |
| `/codex-import` | 立即导入；`--dry-run` 只列出计划 |
| `/codex-skill-sync` | 立即镜像；`--force` 让冲突中较新的一份胜出 |

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `codexHome` | `$CODEX_HOME` 或 `~/.codex` | Codex 主目录 |
| `importSessions.enabled` | `true` | 是否导入 Codex 线程 |
| `importSessions.onStart` | `true` | 启动后跑一次导入 |
| `importSessions.watch` | `true` | 按间隔重复导入 |
| `importSessions.intervalSeconds` | `60` | 后台导入间隔；`0` 关闭定时器 |
| `importSessions.maxThreads` | `100` | 每次最多检查的最近线程数 |
| `importSessions.includeArchived` | `false` | 是否导入已归档线程 |
| `syncSkills.enabled` | `true` | 挂载 provider 并运行镜像 |
| `syncSkills.watch` | `true` | 任一侧技能目录变动时重新镜像 |
| `syncSkills.includeSystem` | `false` | 是否包含 Codex 保留的 `.system` 技能 |
| `syncSkills.overwrite` | `false` | 冲突时是否自动让较新一份胜出 |

## 导入是怎么写会话的

与官方 DeepSeek 聊天导出导入器走同一条路径：

1. `convertThread()` 把一个 Codex 线程转成种子事件：`turn/start`、`step/start`、`user/message`、`assistant/message`、`tool/call`/`tool/result`、`step/end`、`turn/end`。
2. `Session.create()` 对整个种子日志做校验，与真实会话一致。
3. `sessionPersistence.create()` 落盘，刷新投影缓存，再把会话挂到工作区。

手写日志会跳过这些校验，产生 token meter 无法冷重放的会话——那正是老一些的桥接插件不得不在事后修复的问题。

## 限制

- 每个线程只导入一次。导入后 Codex 侧继续追加的内容，`/codex-status` 会提示，但不会自动追加进来。
- 暂不支持把 Harness 会话导回 Codex。
- 导入的工具调用只是历史记录，在 Harness 里不可调用。
- 有意不镜像 `~/.agents/skills`：两边本来就都读这个目录。

## 许可

MIT
