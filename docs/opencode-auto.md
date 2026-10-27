# OpenCode 自动学习接入

与 SI/RSI 无关：这是任务过程中积累、复用工作区经验的插件。

## 安装

在组件目录执行 `npm run build`，随后：

```sh
node dist/packages/cli/opencode-install.js /absolute/workspace provider/model --allow-network --auto-approve
```

重启该工作区的 OpenCode，不能加 `--pure`（它禁用外部插件）。安装器不覆盖已有配置或插件；只安装当前工作区，不改用户全局配置。依赖 Linux `flock`、Node >=22.13 和可用的 `opencode` 命令。插件引用本组件绝对路径，移动组件后需更新引用。

`--allow-network` 明确允许将当前会话轨迹发送给指定 reviewer 模型。`--auto-approve` 是工作区级预授权，不伪装成人工逐条审批；不传它仍会自动复盘，但提案等待批准。配置位于 `.continual-learning/config.json`，设置 `enabled: false` 并重启可停用。正在运行的 reviewer 不会被配置修改立即取消。

## 自动链路

1. 原生 `session.idle` hook 用 SDK 抓取完成的 assistant 回合及会话轨迹，原子写入持久队列。不捕获子会话、错误回合、未完成回合和 reviewer 会话。
2. 启动独立 Node worker；任务窗口不等待模型复盘。`flock` 串行化同一工作区写入，进程退出会释放锁。启动插件也会恢复尚未处理的队列。
3. 复用 LearningCore 完成校验、提案、按配置审批及 Markdown 发布。自动审批的 actor 为 policy，审计记录包含 policyId；仍检查 scope、digest、证据、修订版本及文件漂移。
4. `experimental.chat.system.transform` 在后续模型请求前自动注入已发布经验，无需用户提示查找 skill。参考信息明确低于当前用户指令；超过 32 KB 时不注入并记录错误。

Reviewer 在独立临时目录用 `--pure` 启动，禁工具并设置来源标记，避免自己触发自己。捕获的稳定消息内容和核心事件去重共同避免重复提交。队列不是定时扫描 daemon；意外终止的待处理文件在下次插件加载/idle 时恢复。

## 观察与失败处理

- `.continual-learning/events.jsonl`：idle-enqueued、captured、reviewed、context-injected 及错误状态。
- `.continual-learning/learning.sqlite`：原始证据、提案、修订、提交及审批审计。
- `.continual-learning/queue/*.done`：已完成快照；`*.failed`：需要检查的失败快照。失败不会无限自动重试/花费模型额度；检查问题后将后缀改回 `.json`，下次插件启动会重试。
- `.opencode/skills/continual-learning/SKILL.md`：托管发布产物。

目录包含任务原文，不应提交到 Git。此版本没有秘密扫描、OS 沙箱或语义正确性保证。自动批准可能存入错误经验；可关闭自动批准并使用原有审批/回滚流程。模型复盘异步执行，在发布完成之前立即开始的下一轮可能尚未获得新经验。

## 实验

`CL_AUTO_ROOT=/tmp/fresh-root CL_OPENCODE_MODEL=provider/model node examples/opencode-auto-maze.mjs` 启动真实 OpenCode server，提交两个独立任务并观察 hook 日志。脚本不调用复盘、批准或发布 CLI；第二个任务不提示加载 skill。源迷宫 fixture 当前来自之前实验 `/tmp/cl-maze-20261015-fixed/game`。

### 2026-10-15 实测结果

成功运行目录：`/tmp/cl-auto-maze-20261015-c`；OpenCode 1.18.35，模型 `rpc2/deepseek-ai/DeepSeek-V4.1-Flash`。

- 源会话 `ses_ebf47d3acffetgq0lMGuRywTeE` 完成 README 改动后，18:00:01 UTC 自动入队，18:00:35 自动提交并发布。
- 新会话 `ses_ebf46dcd0ffeWsQ4JEtMp1ZU0n` 在 18:00:37 自动注入经验，用户任务没有提示加载技能。它添加 FAQ 并使用约定术语 wall bumps。
- 新会话完成后也自动入队，18:01:25 再次完成提交。两个复盘都没有手动调用 review/approve/publish。
- `result.json` 保存 hook 时间线，`round-1.json` / `round-2.json` 保存任务响应；完整轨迹和提案在工作区 SQLite/queue 中。
- 这证明自动捕获、提炼、发布、后续上下文注入链路。README 本身也保留了术语，因此不能把第二轮遵守术语归因于注入的独立因果作用。
- 前两次调试未计为通过：首次测试请求启动等待异常，第二次 worker 因绝对路径不能作为 schema scope ID 而失败。已改为工作区摘要 ID，并增加 worker 非零退出日志。诊断时直接运行过失败 worker；最终 c 运行没有这种人工干预。

当前自动提炼仍可能把临时约束保存成长期经验（本次包含“不改配置/隐藏文件”），需要继续评估提炼质量；自动链路成功不等于提案语义完全正确。
