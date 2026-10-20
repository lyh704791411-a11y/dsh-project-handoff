# dsh-project-handoff

> **状态（2026-10-20 03:22）：** 已安装到本机 `desktop` profile 并开启（`- id: project-handoff`，符号链接指向本目录）。JS 单测 48 项、Python 73 项（63 上游 + 10 映射，含 1 项 pwsh 用例）全部通过。自动压缩真机样本已拿到（见「未在运行时验证」第 5 条）；改动后**需重启客户端**新代码才在运行中的进程里生效。

这是一个**纯 Host、无 Client、无 UI** 的 DSH bundle：

- 监听 `session/event`，只统计**自动压缩**次数，按会话落到 `stateDir`。
- 监听 `agent/pre-step`，**每个 turn 注入一次**很短的提醒消息。
- 监听 `agent/turn-stopping`，检查模型最终答复的第一段是否展示了该提醒；`config.steer: true` 时才用 `agent.steer()` 补一次。

它**不是** `project-handoff` 技能本身，也不替代技能：

- 不保存交接材料，不写 `PROJECT_STATE.md`。
- 不新建会话，不替用户点任何按钮。
- 注入的提醒不构成「保存」「新建」「继续」的授权。三个动作的授权边界仍以 `SKILL.md` 为准。
- 插件只增加一条上下文消息并写自己的 state 文件；不改技能、配置或项目文件。

- 包名：`dsh-project-handoff`
- 版本：`0.0.1`（未发布，仅本地目录）
- 入口：`index.js`，命名导出 `name` 和 `apply(ctx, config)`
- 依赖：**无**。不 import 任何 `@deepseek-ai/*` 包（同构 spike 实测本地目录安装解析不到，见 `D:\dsh_table\plugin-spike\README.md`）。

## 文件

```text
plugin/project-handoff/
├─ package.json              # name/private/type/main/dsh.bundle.patch；无 dependencies、无 dsh.client
├─ cordis.patch.yml          # 插入一行 id=project-handoff、name=dsh-project-handoff、config={}
├─ index.js                  # apply(ctx, config)，只 import ./lib/*.js
├─ lib/
│  ├─ util.js                # 默认 stateDir、config 解析、logger/warn-once 小工具
│  ├─ state.js               # 按 sessionId 命名、原子写、损坏回退
│  ├─ count.js               # session/event：自动压缩计数
│  ├─ inject.js              # agent/pre-step：每 turn 注入一次
│  └─ verify.js              # agent/turn-stopping：首段核验 + 可选 steer
├─ test/
│  ├─ helpers.js             # 假 ctx、临时 stateDir；不碰真实 ~/.dsh
│  ├─ count.test.js
│  ├─ state.test.js
│  ├─ inject.test.js
│  ├─ verify.test.js
│  └─ plugin.test.js
├─ python/                   # P1：状态机（上游 63 项测试 + DSH 映射）
│  ├─ handoff_state.py       # vendored 自 Table-skills（MIT），仅改 SKILL 路径
│  ├─ dsh_adapter.py         # DSH 事件 -> 状态机；计数规则与 lib/count.js 对齐
│  └─ tests/
│     ├─ test_handoff_state.py   # 上游 63 项，改 3 处仓库路径
│     └─ test_dsh_adapter.py     # 9 项 DSH 映射用例
└─ README.md
```

## 行为

### 1. 自动压缩计数（`lib/count.js`）

只有以下条件**全部**成立才 `count + 1`：

```text
event.type === 'compaction/end'
AND event.data.error 缺失/为空
AND event.data.turn 是非 null 的 turn（数字；也兼容数字字符串）
AND session.header.origin !== 'subagent'
AND !session.header.parentSession
```

- 手动 `/compact` 的 `turn: null` 不计。
- **失败的压缩不计**：2026-10-20 的真机样本里出现过「`compaction/start` 后 `compaction/end` 带 error」（传输失败），历史没被替换，若按 `start` 计数就会虚报。因此改在 `compaction/end` 且无 `error` 时才 +1。
- 子代理会话（`origin: 'subagent'`）和带 `parentSession` 的子会话不计。
- `turn` 缺失（`undefined`）按「不是自动压缩」处理，不计数。这是有意的保守选择：字段缺失时宁可少计，也不误报。
- 已知偏差：通过服务 API 直接调 `compactRegion()` 的显式区间压缩也带数值 `turn`，会被算作自动压缩；正常桌面使用不会出现。

每次计数写入：

```json
{
  "count": 2,
  "lastCompactionAt": "2026-10-20T02:10:33.412Z",
  "updatedAt": "2026-10-20T02:10:33.500Z",
  "lastInjectedTurn": 7,
  "lastInjectedNotice": "project-handoff：本会话已自动压缩 2 次。",
  "lastInjectedText": "project-handoff：本会话已自动压缩 2 次。\n请把上一行原样写进最终答复正文第一段；这是交接提醒，不涉及文件操作。",
  "lastInjectedAt": "2026-10-20T02:10:34.000Z",
  "lastVerify": null,
  "steeredTurn": null
}
```

`lastCompactionAt` 取 `event.time`（epoch 毫秒）转 ISO；`event.time` 不可用时退回写入时的墙上时间。`updatedAt` 是写入时间。

### 2. 每 turn 注入一次（`lib/inject.js`）

- 监听 `agent/pre-step`（waterfall）。先 `await next()`，再在它返回的 `messages` 末尾追加一条消息。这样不会丢掉默认监听器/其他监听器已经加进去的 runtime-context。
- 去重键是 **sessionId + turn**：内存 `Set` 加 state 的 `lastInjectedTurn`。同一 turn 的多个 step 只注入一次；turn 号变化后允许再注入。
- 没有 `payload.messages` 或数组为空时跳过。
- 注入消息是 `payload.messages[0]` 的克隆：
  - 保留 `role`、`source`、以及其它自定义字段；
  - `content` 替换为单个 `{ type: 'text', text }`；
  - **换一个新的 `id`**（`node:crypto` 的 `randomUUID`），避免和同一条 decision 里即将落盘的原始 user 消息共用身份。
- 文本：

```text
project-handoff：本会话已自动压缩 N 次。
请把上一行原样写进最终答复正文第一段；这是交接提醒，不涉及文件操作。
```

`N === 0` 时第一行是 `project-handoff：本会话尚未自动压缩。`。完整文本硬上限 1000 字符，超出会截断。

### 3. 收轮核验与可选 steer（`lib/verify.js`）

- 监听 `agent/turn-stopping`（serial、await）。
- 取 `payload.agent?.session`；没有 `session` 或没有 `deriveMessages()` 就安全跳过。
- 取最后一条有文本的 assistant 消息，抽出正文第一段：跳过空行、引用块（`>` 开头）、围栏代码块（```` ``` ```` / `~~~` 开头）；遇到第二个空行或非正文块停止。
- 与 state 里的 `lastInjectedNotice` 比对（忽略空白差异，允许第一段包含该行）。结果写 `lastVerify`：

```json
{
  "turn": 7,
  "match": false,
  "expected": "project-handoff：本会话已自动压缩 3 次。",
  "actual": "好的，已经处理完了。",
  "noticeTurn": 7,
  "steered": false,
  "at": "2026-10-20T02:10:40.000Z"
}
```

- `config.steer` **默认 `false`**。
- 只有在 `steer === true`、`match === false`、本 turn 尚未 steer 过时才补一次：
  - 取最后一条**真实用户消息**（跳过 `source.kind === 'runtime-context'` 的运行时上下文消息）；
  - 用与 inject 相同的克隆方式，把文本换成上一次注入的完整文本；
  - 调 `agent.steer(clone)`，并把 `steeredTurn` 写进 state；
  - 内存里也记一份，保证即使 state 写失败，同一 turn 也不会 steer 第二次。
- `steer` 失败只 `logger.warn`，不抛；`turn-stopping` 是 await 的，不能让插件异常中断收轮。

### 4. 状态目录与失败策略（`lib/state.js`）

- 默认 `path.join(os.homedir(), '.dsh', 'state', 'project-handoff')`，不写死用户名。
- 每个会话一个 JSON，文件名由 sessionId 做安全化处理（去掉路径分隔符/前导点、限长、追加 8 位 sha256），例如 `7f3a...-1a2b3c4d.json`。
- 写入流程：先写同目录临时文件，再 `renameSync` 覆盖；正常情况下不会留下 `.tmp`。
- 读文件缺失 → 空状态，不 warn。
- JSON 损坏/不是对象 → 空状态，同一文件只 warn 一次。
- 写失败（目录不可建、文件不可写）→ 返回 `false`，同一路径+错误码只 warn 一次，不抛。
- 不清理旧会话文件；一个会话一个文件，没有轮转。

## Python 部分（P1，混合路线）

- `python/handoff_state.py`：上游 `compaction_reminder.py` 的 vendored 副本（MIT，版权见 `NOTICE`），只把 `SKILL` 解析改成 DSH 路径；状态机、阈值、冷却、提案生命周期不变。
- `python/dsh_adapter.py`：把 DSH 事实映射成状态机输入。计数规则与 `lib/count.js` 完全对齐：只在 `compaction/end` 且无 `error` 时计，`turn` 非空（数字或非空字符串）、`origin !== 'subagent'`、无 `parentSession`；手动 `turn: null` 与失败的压缩都不计。
- 调用方式：由 Agent 在需要时调用（不挂每个事件），避免每事件 spawn 进程；JS 仍负责事件、注入、核验。
- 测试：`cd python && py -3 -m unittest discover -s tests -p "test_*.py"` → **73 项通过、0 跳过**（63 上游 + 10 DSH 映射）。其中 1 项 pwsh 用例需要 PATH 里有 `pwsh`（Windows 上装 PowerShell 7 即可；没有时会记为 skipped，不算失败）。
- 与上游的差异：3 项文档布局用例改为检查 DSH 技能目录与模板；Codex hooks 模板用例改为「CLI 在 PowerShell 下跑一次 PostCompact」；新增 10 项 DSH 事件映射。

## 变更记录

- 2026-10-20 03:22：计数改到 `compaction/end` 且无 `error`（修「失败压缩也计数」的虚报）；新增 3 项 JS 测试与 1 项 Python 测试；拿到真实自动压缩样本（`turn: 1`）；JS 48 项、Python 73 项全过。
- 2026-10-20 03:00：新增 `python/`（P1 混合路线），72 项 Python 测试通过（上游副本仅作移植基准，不随包分发）。
- 2026-10-20 02:56：重新开启插件，用于捕获自动压缩样本。
- 2026-10-20 02:40：安装、子代理试用一次、关闭（证据是本地 state 目录里的一次会话记录）。
- 2026-10-20 01:30：初版 JS 44 项测试通过。

## 配置

本包**没有 Config schema**（为了不依赖 `@deepseek-ai/schemastery`）。`cordis.patch.yml` 里传的是空对象；需要覆盖时，在 profile 的 patch 层给这一行整体替换 `config`：

```yaml
- id: project-handoff
  config:
    stateDir: 'D:\dsh-logs\project-handoff-state'
    steer: true
```

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `stateDir` | string | `~/.dsh/state/project-handoff` | 支持开头 `~`；相对路径按 Host 进程 cwd 解析为绝对路径。 |
| `steer` | boolean | `false` | 仅显式 `true` 时启用收轮补漏。 |

注意：Loader 的 `config` 是**整体替换、不做深合并**；写 `steer: true` 时如果还要自定义 `stateDir`，两个键都要写。这个覆盖路径没有在真实 profile 里验证过。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile desktop add github:lyh704791411-a11y/dsh-project-handoff
```

装好后重启客户端，插件对该 profile 的所有会话生效。

### 从本地目录安装（开发用）

用 `plugin_manager` 的 `install_bundle`，`target` 用绝对目录：

```json
{ "action": "install_bundle", "target": "<本仓库的绝对路径>" }
```

- 本包没有 `dependencies`，安装不需要访问 registry。
- 本地目录安装是链接；`package.json` 的 `files` 不过滤目录内容。
- 安装结果看 `application` 字段；`already-installed` 不会重新加载。
- 安装会写入当前 profile，影响该 profile 的所有会话。

装好后可先确认：

```json
{ "action": "list_plugins", "name": "dsh-project-handoff" }
```

## 卸载（用于关闭或移除；2026-10-20 已执行过关闭）

```json
{ "action": "list_bundles" }
{ "action": "remove_bundle", "target": "dsh-project-handoff" }
```

`remove_bundle` 的 `target` 以 `list_bundles` 返回为准。卸载不会删除 state 文件；需要清理时手动删 `~/.dsh/state/project-handoff/`（插件本身不删文件）。

## 看结果

默认目录：`~/.dsh/state/project-handoff/`。PowerShell：

```powershell
$dir = Join-Path $HOME '.dsh\state\project-handoff'
Get-ChildItem -LiteralPath $dir
Get-Content -LiteralPath (Get-ChildItem -LiteralPath $dir -Filter *.json | Select-Object -First 1).FullName |
  ConvertFrom-Json | Format-List
```

重点字段：

- `count`：本会话自动压缩次数。
- `lastCompactionAt` / `updatedAt`：最近一次计数时间 / 最近一次状态写入时间。
- `lastInjectedTurn` / `lastInjectedNotice`：最近一次注入的 turn 和 notice 行。
- `lastVerify`：最近一次收轮核验的 `match`、`expected`、`actual`。
- `steeredTurn`：最近一次 steer 的 turn（`null` 表示没 steer 过）。

插件失败只会出现在 Host 日志里，前缀是 `project-handoff:`；同一类失败只 warn 一次。

## 验证（真实输出）

在本目录执行：

```powershell
Get-ChildItem index.js, lib\*.js, test\*.js | ForEach-Object { node --check $_.FullName }
node --test
```

本次实际结果：

- `node --check ...`：12 个 JS 文件全部通过，无输出。
- `node --test`：**48 pass / 0 fail**（2026-10-20 03:19 复跑；其中 47 个 `test()`，Node 另外把 `test/helpers.js` 当成一个空测试文件列出）。覆盖：
  - `shouldCount`：自动、手动 `turn:null`、失败压缩（`end` 带 error）、只到 `start` 未结束、`origin:'subagent'`、`parentSession`、`turn` 缺失、非 `compaction/end`。
  - 计数落盘、失败一次+成功一次只记 1、两个会话互不影响、写失败不抛且只 warn 一次。
  - state 读写、原子写无 `.tmp`、损坏 JSON 回退、缺文件不 warn、文件名安全化、写失败。
  - inject 每 turn 一次、保留原 messages、克隆字段与 content、notice 长度上限与截断、N=0、无 messages、reject、追加到后置监听器已替换的 messages。
  - verify 首段提取（普通/引用/代码块/空）、`lastVerify`、steer 开关、每 turn 最多一次、跳过 runtime-context、缺 `agent.session`/`deriveMessages` 时安全跳过。
  - `index.js` 的 `apply` 注册三个监听器；没有 `on()` 时是 no-op。

所有测试使用 `os.tmpdir()` 下的临时目录，并在结束后删除；**没有读写真实的 `~/.dsh`**。

## 未在运行时验证 / 不确定点（不要当成已验证）

以下是**单测通过 ≠ 真实 DSH 里成立**的部分：

1. **UserMessage 的构造字段**：注入消息是 `payload.messages[0]` 的克隆，换 `id`、换 `content` 为单个 text block。`content` 用 text block 数组、`id` 用 UUID，是照 `dsh-llm` 的 `createMessage` / `createUserMessage` 源码形状推断的；没有在真实 Session 里 append 过，因此“这条消息能否被 session 正常接受、投影、持久化”未验证。若真实消息还要求其它字段（例如时间/来源约束），可能被拒绝或表现异常。
2. **`agent/pre-step` 的 `enter` 决策**：代码先 `next()` 再在 `decision.messages` 末尾追加。保留默认 runtime-context 是源码推断；真实模型是否看到这条消息、是否按预期只注入一次，未跑过。
3. **`agent/turn-stopping` 的 payload**：inspect 签名是 `{ agent, turn, signal }`；当前构建的 `agentEvents` 源码确实往 payload 里注入了 `agent`。但 inspect 暴露的 `Agent` 接口只有 `id`，**没有声明 `session`**；`agent.session` 是读 `dsh-agent-loop/lib/index.js` 的构造器推断的。若运行时拿不到 `agent.session`，verify 会安静跳过（单测覆盖了这条退化路径），但也就不会核验/steer。
4. **`agent.steer()` 是否接受克隆消息**：源码 `steer(input) { this.send(input, 'next-step', true) }` 和 `send` 里 `[message]` 的包装表明它接收**单条** UserMessage；传数组会嵌套。本插件传的是单条克隆。真实调用是否成功、是否触发额外一步、是否会被模型/loop 拒绝，未验证。
5. **自动压缩事件本身**：~~只有源码证据~~ → **2026-10-20 已拿到真实自动压缩样本**（headless + `--patch` 把 `thresholdRatio` 降到 0.02）：
   - 成功样本 `session-1b902d31-…`：`compaction/start` seq 85 `turn: 1` → `compaction/summary` seq 87 → `compaction/end` seq 89，**无 error**，历史被替换；`turn` 是数字 `1`。
   - 同会话还有一个失败样本 seq 68/69（`turn: 1` + `error: DeepSeek Messages transport failed`），正是靠它发现「按 start 计数会虚报」，据此把规则改到 `compaction/end` 且无 error。
   - 回放脚本：开发目录里的 `verify-real-compaction-events.mjs`（真实事件 + 真实 `lib/count.js`），结果 `count: 1`、提醒 `project-handoff：本会话已自动压缩 1 次。`
   - 仍未验证：桌面 profile 默认阈值（约 67.8 万 tokens）下自动压缩在真实 GUI 会话里的现场注入（在真实会话里从没触发过）。
6. **提醒的展示效果**：注入文本要求模型把上一行原样写进最终答复第一段；模型是否遵守完全未验证。`steer` 默认关闭正是为了避免在没有真实样本时引入额外模型调用。建议先在只读观察模式（`steer:false`）看 `lastVerify.match`。
7. **`steer` 的循环风险**：已有「每 turn 最多一次」的内存 + `steeredTurn` 双重闸门，但真实 loop 在 steer 后可能再次触发同一 turn 的 `turn-stopping`；单测覆盖了同一 turn 重复调用的场景，未在真实 loop 里跑过。
8. **配置覆盖**：`stateDir`/`steer` 的 profile patch 覆盖没有端到端验证；也没有 Config schema，写错类型不会在加载时报错。
9. **隐私**：`lastVerify.actual` 会保存模型最终答复的第一段文本（可能含用户内容）；`lastInjected*` 含固定提醒文本。分享 state 文件前先脱敏。插件本身不保存完整对话。
10. **清理**：没有按时间/大小清理 state 文件；会话多时文件会累积。
11. **注入消息的角色是 `user`**：模型可能把提醒当成新的用户指令，而不是背景提示；真实对话里是否干扰原任务、是否打断工具链，未验证。`steer` 补发的同样是 user 消息，因此默认关闭。

## 与技能的关系

配套技能（`project-handoff`，提供 `/project-handoff` 入口）不随本包分发，装在用户级技能目录（DSH 下通常是 `~/.dsh/skills/project-handoff`）。技能里写的是「DSH 没有自动压缩计数」，装插件后计数会出现在提醒里；但**未安装**本插件时该事实仍然成立，技能不应假设插件存在。插件只提供计数与提醒，不改变技能的授权规则：

- 提醒不写文件、不授权保存或新建。
- 保存材料仍要用户明确要求/确认。
- 新建会话仍必须由用户在界面完成；插件没有建会话能力。

## License

MIT，见 [LICENSE](LICENSE)。JS 部分是原创；`python/handoff_state.py` 等文件派生自 Table-skills（上游 MIT），修改范围写在 [NOTICE](NOTICE)。
