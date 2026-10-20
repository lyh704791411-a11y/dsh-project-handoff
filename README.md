# dsh-project-handoff

[![checks](https://github.com/lyh704791411-a11y/dsh-project-handoff/actions/workflows/ci.yml/badge.svg)](https://github.com/lyh704791411-a11y/dsh-project-handoff/actions/workflows/ci.yml)

一个给 DeepSeek Harness（DSH）用的 Host 插件：统计自动压缩次数，并且只在新发生一次自动压缩之后，往下一轮里放一句很短的提醒，提示模型该整理交接材料了。

纯 Host 实现，没有界面，没有客户端代码。

---

## 做什么

- 监听会话事件，数一数这个会话被自动压缩过几次。
- 只在有新压缩时提醒一次，例如：本会话已自动压缩 2 次。没压缩过的会话永远不打扰。
- 可选：检查那一次答复的第一段有没有把这句话原样带上；没带就再补一次（默认关闭）。

## 不做什么

- 不保存交接材料，不写交接文档。
- 不新建会话，不替任何人点按钮。
- 提醒本身不构成「保存」「新建」「继续」的授权。
- 不修改技能、profile 配置或任何项目文件；只写自己的状态文件。

## 安装

从 GitHub 安装（推荐）：

```bash
dsh plugin --profile desktop add github:lyh704791411-a11y/dsh-project-handoff
```

从本地目录安装（开发用）：在 DSH 里用 plugin_manager 的 install_bundle，target 填本仓库的绝对路径。

装完重启一次客户端，插件才会加载进运行中的进程。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-project-handoff
```

或在 DSH 里用 plugin_manager 的 remove_bundle。卸载不会删除状态文件；要清理就手动删状态目录。

## 配置

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| stateDir | 字符串 | 用户目录下的 .dsh/state/project-handoff | 状态文件目录，支持开头的波浪号 |
| steer | 布尔 | false | 设为 true 才启用「没带提醒就补一次」 |

在 profile 的 patch 层覆盖时要注意：Loader 对 config 是整体替换，不做深合并。所以两个键都要写全：

```yaml
- id: project-handoff
  name: dsh-project-handoff
  config:
    stateDir: ~/.dsh/state/project-handoff
    steer: false
```

本包没有 Config schema（为了保持零依赖），类型写错不会在加载时报错，只会静默失效。

## 计数规则

一次压缩要同时满足下面全部条件，计数才会加一：

1. 事件类型是 compaction/end；
2. 这个事件没有 error 字段（失败的压缩不改变历史，不能计数）；
3. turn 不是空值（自动压缩带数字 turn，手动压缩带空值）；
4. 会话不是子代理（origin 不是 subagent）；
5. 会话没有 parentSession（不是派生出来的子会话）。

几个容易踩的点：

- 手动压缩不计数：用户主动清理上下文时 turn 是空值，按设计略过。
- 失败不计数：真机上出现过「开始压缩，然后传输失败」，历史根本没被替换；所以计数点放在结束事件上，而不是开始事件上。
- 字段缺失按不计数处理：宁可少算，不虚报。
- 已知偏差：通过服务接口直接调用的显式区间压缩也带数字 turn，会被当成自动压缩。

## 注入与核验

- 注入时机是压缩之后的那一轮，第一个步骤；一次压缩只提醒一次。
- 注入内容是一条克隆出来的用户消息：正文换成提醒，来源标记强制改成普通用户消息。否则在多轮目标会话里会被误认成新的目标轮次，导致目标回放失败。
- 正文上限 1000 字符。
- 核验（可选）只在收到提醒的那一轮结束时有意义：读模型的最后一条答复，取正文第一段（跳过空行、引用块、代码块）做包含匹配，结果写进状态文件；只有开启 steer 时才会补发一次。

## 状态文件

默认放在用户目录下的 .dsh/state/project-handoff，文件名是「会话编号 + 短哈希」。示例：

```json
{
  "count": 2,
  "lastCompactionAt": "2026-10-20T02:10:33.412Z",
  "lastInjectedTurn": 7,
  "lastInjectedCount": 2,
  "lastInjectedNotice": "project-handoff：本会话已自动压缩 2 次。",
  "lastVerify": { "turn": 7, "match": true, "steered": false }
}
```

状态文件不会自动清理，会话多了会慢慢变多，需要时手动删目录即可。

## 开发与测试

```bash
# JavaScript：48 项
node --test

# Python：73 项（其中 1 项需要 PATH 里有 PowerShell 7，没有会记为跳过）
cd python
python -m unittest discover -s tests -p "test_*.py"
```

测试全部使用系统临时目录，不读写真实用户目录。

仓库结构：

```text
.
├─ index.js                # apply(ctx, config)
├─ cordis.patch.yml        # 注册 id=project-handoff
├─ lib/
│  ├─ util.js              # 配置解析、logger
│  ├─ state.js             # 按会话存状态，原子写、损坏回退
│  ├─ count.js             # 计数规则
│  ├─ inject.js            # 每轮注入
│  └─ verify.js            # 首段核验 + 可选 steer
├─ python/
│  ├─ handoff_state.py     # 上游状态机（vendored，MIT）
│  ├─ dsh_adapter.py       # DSH 事实 -> 状态机
│  └─ tests/
├─ test/                   # JS 测试
└─ .github/workflows/ci.yml
```

## 已知限制

- steer 这条路径默认关闭，还没有在真实会话里跑过；单测只覆盖了「每轮最多补一次」的闸门。
- 自动压缩的触发门槛很高（默认约 67.8 万 token），日常对话基本不会触发，所以提醒通常显示「尚未自动压缩」。
- 注入消息和核验逻辑已在真实会话里跑通，但没有经历长期多轮观察。
- 状态文件里会保存模型答复的第一段文本，分享前请脱敏。
- 没有按时间或大小做清理。

## 与 project-handoff 技能的关系

本插件只是计数和提醒。真正的交接流程（斜杠命令入口、保存、恢复、授权规则）来自配套技能 project-handoff，仓库在 lyh704791411-a11y/project-handoff-skill，需要单独装到 DSH 的技能目录。

没装技能时插件照样工作，只是没有人消费这条提醒。

## License

MIT，见 LICENSE 文件。JS 部分是原创；python 目录下的状态机派生自 Table-skills（同样 MIT），修改范围写在 NOTICE 文件里。
