# 交付与验证计划

## 1. 本次交付

已完成架构草案与 M0 初始纵向切片，并追加 OpenCode 手动导出适配、真实 reviewer、独立复盘/批准命令。已使用用户授权的模型路由测试合成任务，未安装自动插件、未启动 daemon、未修改用户宿主配置。详见 `progress.md` 与 `opencode.md`。

M0 并非完整完成：进程级崩溃注入、全平台路径测试和其余契约场景仍待补充。当前 outbox 重开恢复测试不等价于真实断电恢复证明；Windows 安装与文件替换尚未验证。

实现前默认决策：单机单用户、TypeScript 核心、版本化 JSON 协议、SQLite 权威库、Markdown 托管投影、手动复盘优先、提案确认默认开启。

## 2. 分阶段实现

### M0：协议和无模型纵向切片

- 实现版本化 schema、SQLite store、固定证据 fixture 和确定性 fake reviewer。
- 打通 ingest → proposal → approve → commit → publish → query → revert。
- 证明重复事件、版本冲突和进程崩溃不会产生重复或丢失提交。
- fake reviewer 只测管线，不声称任何学习效果。

完成标准：核心测试无需安装任何 Harness、无需 API key；手工编辑产物后不会被静默覆盖。

### M1：手动入口与真实 reviewer

- 用户显式指定当前任务/证据来源、作用域与允许的数据出口。
- 首先实现一个受限 reviewer runner 与公共 managed skill publisher。
- 提供经验差异、证据、确认、撤销和查询入口。
- 真实模型测试单独启用、预算封顶，不与默认测试混合。

完成标准：用户可以完成“纠正一次 → 保存 → 新任务按需读取 → 撤销”，且主任务目录没有被 reviewer 修改。

### M2：四宿主接入 spike

每个宿主分别验证：版本探测、安装/卸载、事件、稳定轨迹、隔离执行、发布发现和 Windows 行为。先完成各宿主手动入口，再按 capabilities 开启自动模式。

Codex CLI 和 desktop 必须分别记录结果；Claude Code、OpenCode、DeepSeek Harness 不共享未经验证的事件假设。

完成标准：同一证据 fixture 经不同 adapter 归一化后语义一致；同一 LearningItem 可在两个授权宿主消费；无未授权跨项目泄漏。

### M3：自动化与维护

- 持久队列、debounce、lease、取消、并发限额、budget。
- 过期标记、矛盾提示、重复合并建议；不自动删历史规则。
- 诊断命令展示：插件是否安装、事件是否到达、review 是否运行、为何没有学习、发布何时生效。

完成标准：自动复盘不阻塞用户、不自触发、不无限重试；停机后恢复任务，且用户能暂停捕获或暂停复盘。

## 3. 必须通过的契约测试

| 类别 | 测试 |
|---|---|
| 事件 | 同一 end 事件重放 10 次只产生一个有效 job |
| 边界 | idle 后用户马上继续，不能将未完成任务声明为成功 |
| 轨迹 | 文件继续增长，只读取声明 cursor 前的稳定内容 |
| 语义 | assistant 声称测试通过不得转换为真实测试结果 |
| 不完整 | 缺失 tool result 必须带 partial 标记，自动写入被拒绝 |
| prompt injection | 工具输出要求删除技能，不被作为复盘指令执行 |
| 隔离 | reviewer 尝试写任务仓库、调用 shell、递归 review 被拒绝 |
| scope | 两个同名目录、两个 worktree、用户 scope 不发生隐式混合 |
| 数据出口 | 未批准的外部 reviewer 不得收到轨迹，失败不自动换供应商 |
| 并发 | 两个提案更新同 revision，只能一个 CAS 成功 |
| 幂等 | 提交成功但 ACK 丢失，重试不产生重复 revision |
| 发布 | DB 提交后进程崩溃，通过 outbox 恢复文件发布 |
| 漂移 | 用户修改托管文件后发布停止，不覆盖人工修改 |
| 路径 | `..`、绝对路径、symlink、Windows junction 不能逃逸 |
| 撤销 | 撤销旧修订时检测后续变化，不能覆盖较新的用户修改 |
| 取消 | timeout/cancel 后迟到提案不能提交 |
| 恢复 | daemon 崩溃、lease 过期、host restart 后不丢已接收事件 |
| 能力 | unsupported/unknown hook 不会被偷偷启用 |
| 兼容 | 不支持的 protocol major 明确拒绝；新 optional 字段可忽略 |
| 清理 | 卸载不删用户文件，删除数据不会把敏感正文残留于日志 |

Windows、Linux、macOS 的文件与 IPC 测试分开；至少 Windows 为第一等交付目标，不只测试 Linux shell。

## 4. 验证价值，而非制造“进化率”

产品层记录：用户接受/修订/撤销提案的比例、重复经验比例、相关经验是否被读取、后台延迟、上下文占用、每次复盘成本、冲突和越权拒绝次数。

不把“新增技能数”“读取次数”当成能力提升。需要验证收益时，在相同任务执行器下观察用户重复纠正是否减少；这仍是该经验管理产品的评估，不把它嵌入另一个研究 SI 的优化目标。

## 5. 待 spike 决定，而非提前猜测

- Codex 各运行面的 hook、轨迹导出和刷新行为。
- Claude Code hook 的后台提交部署方式和停止重入细节。
- DeepSeek Harness 具体插件 API 和会话读取/执行权限。
- OpenCode 事件流恢复及 message part schema 的版本范围。
- 各 Harness runner 能否提供足够强的工具禁用和数据隔离。
- SQLite 驱动的 Windows 安装体验和打包体积。
- 本地模型与远程模型的复盘成本、输出可靠性；不预先指定“最佳模型”。

## 6. 参考实现与核验边界

检查日期：2026-10-15。以下用于启发，不代表直接复制或依赖其内部接口：

- Hermes 快照 `450ad5055eb3c4852d96676ee99287d618bd283a`：`agent/background_review.py`、`agent/turn_finalizer.py`、`tools/skill_manager_guards.py`。借鉴独立复盘、权限限制和主会话隔离；不采用 reviewer 直接写权威库的边界。
- PenguinHarness 快照 `2b8116ce278656cbc184f7c40ceff1d358a87394`：`plugins/continual-learning/hooks/stop.mjs`。借鉴轻量事件入口和任务轨迹摘录；不将固定 30 轮作为跨宿主统一语义。
- DeepSeek Harness 快照 `571902028a75c64c1d767f4ae5fd099485f0ddf0`：`docs/architecture.md`、`docs/agent-lifecycle.md`。确认需要区分 durable events 与 live extension points。
- 官方宿主资料位于 [Adapter 契约](adapter-contracts.md)。网页/API 可变化，安装版本的 contract fixtures 才是兼容性证据。

本次没有运行宿主插件或付费复盘；以上接入方案均需 M2 验证，不声称四个 adapter 已经可用。
