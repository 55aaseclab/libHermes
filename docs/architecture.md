# 架构设计

状态：Proposed。本文定义目标协议，不声称已有实现。

## 1. 要解决什么

用户在任何任务 Harness 中完成工作之后，不应反复丢失同样的操作经验。组件应做到：

1. 用户可以明确说“记住这条纠正”，无需完成整场复盘。
2. 复杂任务结束后可以整理经验，但不阻塞主任务，也不强制每次都产生修改。
3. 下次遇到相关任务时，能够发现适用经验，而不是加载全部历史。
4. 换 Harness 后继续使用经授权共享的经验，而不是迁移整个聊天系统。
5. 用户能回答：这条经验从哪来、为什么保存、用于哪里、怎样撤销。

非目标：自修改优化器、任务成功判定器、跨代能力证明、任务求解器、无边界自主 Agent。**经验整理有用，不等于系统已实现研究意义上的 SI/RSI。**

## 2. 核心边界

```text
宿主插件 / 手动命令 / 本地桥接进程
        │ HostAdapter
        ▼
事件归一化 ──→ 任务证据快照 ──→ 数据策略与脱敏
        │                            │
        ▼                            ▼
持久任务队列 ──→ 检索已有经验 ──→ ReviewerAdapter
                                       │
                                  ProposalSet
                                       │
                         结构检查 / 来源检查 / 授权
                                       │
                              用户确认或自动策略
                                       ▼
                              事务写入 LearningStore
                                       │
                                  发布 Outbox
                                       ▼
                               SkillPublisher
                                       │
                                宿主发现 / 按需读取
```

### 2.1 为什么不是一个巨大的 HarnessAdapter

读轨迹、调用模型和发布技能是三个不同的变化轴。把它们塞到一个适配器，会导致“增加第五个 Harness 就要重写整套学习流程”，也不利于支持跨后端复盘。

| 组件 | 负责 | 不负责 |
|---|---|---|
| HostAdapter | 宿主能力探测、生命周期事件、稳定轨迹读取、作用域上下文 | 判定哪些经验正确、直接写库 |
| ReviewerAdapter | 在受限环境分析证据，输出结构化修改提案 | 选择真实写入路径、批准自己的提案 |
| LearningCore | 触发策略、证据构建、检索、提案处理、队列、发布调度 | 识别厂商私有消息字段 |
| LearningStore | 事务、版本、来源、索引、冲突与撤销 | 渲染特定厂商技能格式 |
| SkillPublisher | 投影为宿主支持的技能、托管入口或工具资源 | 偷改 AGENTS.md / CLAUDE.md，删除用户文件 |

第一版使用本地 daemon/worker 作为执行形态之一，但核心本身是可嵌入库。宿主 hook 只提交事件并等待持久化确认，不等待 LLM 完成。无常驻进程时可用前台 CLI 执行同一 pipeline；缺少后台运行能力必须向用户说明。

### 2.2 模块建议

```text
packages/
  protocol/           版本化 JSON Schema、数据类型、错误分类
  core/               调度、提案规则、检索策略、应用服务
  storage-sqlite/     本地存储与事务、FTS 检索、outbox
  reviewer-runner/    外部进程 / 宿主独立会话的公共执行支架
  publisher-skills/  可复用的托管 SKILL.md 输出器
  adapters/
    codex/
    claude-code/
    deepseek-harness/
    opencode/
  cli/                显式复盘、查看、确认、撤销、诊断
  daemon/             本地队列消费、IPC、取消与重试
tests/
  contract/           所有 Adapter 必须通过的行为测试
  fixtures/           脱敏、固定版本的各宿主事件和轨迹
```

建议用 TypeScript 开发第一版，但**外部协议只依赖 JSON/JSONL**，不依赖 TypeScript 的对象布局或模块加载器。Python adapter 也可以作为协议进程接入。不要为了插件安装自动执行任意来源的 npm/Python 包。

## 3. 标准数据模型

### 3.1 任务边界不是消息计数

`session` 是会话；`turn` 是宿主交互单元；`task` 是一个有边界的工作窗口。不同 Harness 的 turn 语义不同，不能统一解释为“超过 10/30 条消息”。

`TaskWindow` 包含：

- host installation ID、session ID、task ID、起止 cursor；
- boundary quality：`explicit | inferred | manual`；
- completion：`completed | failed | interrupted | unknown`；
- workspace scope 与用户指定目标；
- 按类型计数的调用数、时间、token 使用量，缺失时为 unknown；
- stable snapshot digest、轨迹完整性及遗漏说明。

“turn ended”只代表宿主结束一轮，不代表任务成功。`idle` 只是候选触发信号；经过防抖、边界识别和新活动取消后才进入复盘。部分轨迹默认只允许生成待确认建议。

### 3.2 证据不是模型结论

统一证据事件类型：`user_message`、`assistant_message`、`tool_call`、`tool_result`、`artifact_ref`、`task_outcome`。

- `assistant_message` 中的“测试通过”只是模型声明。
- 退出码为零是某个命令的执行结果，不自动等价于任务成功。
- 工具输出、仓库文件及网页内容都是不可信数据，不是复盘指令。
- 用户纠正保留其来源、对象与原始语境，不自动变为全局规则。
- 不要求、不采集隐藏推理。默认不收集图片、二进制和完整大文件。

证据优先保留用户纠正、失败→修复→执行结果、使用过的技能和有意义的产物差异；压缩只产生派生材料，不覆盖原始出处。每个摘要片段仍必须指向其输入证据 ID。

### 3.3 LearningItem

每条经验至少包含：

| 字段 | 含义 |
|---|---|
| id / revision | 稳定 ID 与不可复用的递增修订号 |
| kind | preference / procedure / environment_fact / pitfall |
| title / body | 可读名称与正文 |
| scope | user / workspace；默认 workspace |
| applicability | 语言、平台、工具、版本、任务标签与前置条件 |
| evidence_refs | 证据 ID、片段范围、脱敏后摘要 hash |
| epistemic_status | user_asserted / observed / inferred，不叫 verified |
| lifecycle | proposed / active / stale / archived / conflicted |
| origin | task / review / import / user_edit，含 job 与 adapter |
| relations | supersedes / contradicts / related_to |
| timestamps | 创建、修订、使用、过期检查时间 |

`observed` 表示有可追踪的观察，不保证可泛化。失败经验必须描述适用条件，避免把一次超时写成“这个工具永远不可用”。机器相关路径或命令不自动作为跨平台通用经验发布。

### 3.4 ProposalSet

复盘模型只能输出：`create`、`revise`、`archive`、`no_change` 四类操作。每个操作给出目标 ID、预期 revision、正文、作用域、证据引用和理由；**不提供任意文件路径、shell 命令或 SQL**。

一个任务可以产生零条经验。`no_change` 是正常结果，不应因“学习次数”指标诱导模型灌水。

## 4. 生命周期

### 4.1 捕获和调度

1. HostAdapter 识别任务边界并提交事件；核心返回持久化 receipt。
2. 去重键由 installation/session/task/end cursor/review policy version 构成。
3. 证据读取截止于稳定 cursor，不能边读持续增长文件边假装得到确定快照。
4. 队列写入成功即释放宿主；不让 hook 长时间等待模型。
5. 对新活动、重复 stop、宿主崩溃、会话恢复进行防抖和重放处理。

队列状态：

```text
queued → running → proposed → awaiting_approval → committed
             ├→ no_change
             ├→ retry_wait → queued
             ├→ failed / cancelled
             └→ needs_input
committed → publish_pending → published / publish_failed
```

采用至少一次事件投递 + 幂等提交，不承诺端到端 exactly-once。每个任务使用 lease 和 heartbeat；进程崩溃后回收 lease。一个 proposal 的 `commit_key` 唯一，重试不能产生重复 revision。

### 4.2 复盘执行

证据包和相关经验快照交给 ReviewerAdapter。默认使用与任务相同的模型路由只是配置选择，不是核心假设。

- 纯推理后端：通过结构化输出返回 ProposalSet。
- Harness 后端：在独立临时工作区启动受限会话，只提供证据包与必要读取工具。
- 不恢复主任务会话继续聊天；不继承 shell、写用户仓库、浏览网页等权限。
- 每个 review 带 `origin=continual_learning_review`、parent job ID、禁子复盘标记。
- 无法证明工具权限或输出隔离的 runner，只支持人工复盘，不启用 unattended 模式。
- 模型和 token、耗时、费用上限可配置；费用不可得时报告 unknown，不编造。
- 重试有上限；格式错误有限次修复；鉴权错误直接停下；取消后拒收迟到结果。

不把轨迹里的提示词当作 system instruction。prompt 约束不足以保护存储，必须通过 runner 权限隔离和核心写入 API 同时收紧。

### 4.3 写入策略

默认 `propose`：生成差异和证据，由用户确认。可选 `auto_managed`：自动写入插件托管空间，但不扩大 scope、不删除用户规则、不自动解决矛盾。

核心执行 schema、证据引用、scope、权限、重复、大小限制和版本检查；这些检查只保证符合存储协议，**不保证学习内容正确**。

- 原有用户文件只读导入或作为上下文，不自动接管。
- workspace→user 升级、冲突覆盖、删除、敏感内容需显式确认。
- 两个 reviewer 基于同一 revision 修改时，采用 CAS；失败后重读并重新提案，不能 last-writer-wins。
- 一个 ProposalSet 默认全有或全无；用户选择部分操作后生成新的批准集合并重验依赖。
- 自动写入异常时保留旧版本；不能为了得到学习结果修改任务成功判断。

### 4.4 发布和读取

权威库采用 SQLite，事务内写 item/revision/evidence/audit/outbox。发布文件是 outbox 的可重试副作用。

1. Publisher 将 active items 按主题生成托管技能，输出 owner marker 和 digest manifest。
2. 生成临时文件后原子替换；目录外路径、symlink/junction 重定向必须拒绝。
3. 多文件发布携带 generation ID；恢复时依据 manifest 清理未完成 generation。
4. 人工编辑托管产物时检测 digest drift，不静默覆盖：导入为建议、另存或要求用户处理。
5. 撤销生成新 revision 和新的发布任务，不抹除审计史。
6. 同一 item 可发布到多个宿主；某个宿主发布失败不撤销已提交的权威数据。

消费方式优先：按需检索工具 > 宿主原生技能发现 > 用户批准的轻量入口。不得通过后台修改 AGENTS.md/CLAUDE.md 来偷偷接入。

检索先按 scope、环境、版本和权限过滤，再做全文检索与排名。初版使用 SQLite FTS；embedding 是可选扩展，不是核心依赖。上下文有字数/token 预算；归档、冲突和过期经验默认不注入。

## 5. 安全与隐私

- 跨宿主共享是用户显式配置的作用域绑定，不是“同一台机器就互通”。
- workspace ID 使用首次注册 UUID + 路径别名；不只取目录名或 git remote，避免重名、fork、worktree 泄漏。
- 默认仅本地保存必要证据摘录；凭据、令牌、环境变量值和大段私有源码不自动保留。
- 发送外部 reviewer 前执行脱敏；用户可限制后端、禁传范围、只在本地人工处理。
- 敏感检测不是完美保证；高敏项目可彻底禁用捕获，不能以“已脱敏”为由绕过策略。
- IPC 使用本机 socket/named pipe 与访问控制，默认不开放 TCP。安装时不要求管理员权限。
- retention 策略区分原始快照、证据摘录与经验；删除来源后保留 tombstone 并标记证据不可重查，不伪装证据仍完整。
- 审计只记录必要元数据和 hash，不能把被删除的秘密复制进审计日志。

## 6. 平台与故障边界

- Windows 支持 named pipe、路径大小写/盘符、junction、文件占用时的有限重试；不得以未转义命令串拼接 CLI。
- WSL / 容器和 Windows 宿主之间通过明确的路径映射注册，不推测其文件系统相同。
- 发布宿主技能时尊重格式、刷新时机和可见范围，不能保证更新立即进入当前会话。
- hook 重入、review 自触发、多个 Harness 同时改同一经验必须有测试。
- graceful shutdown 不等待无限 review；已接受事件保留队列，下次恢复。
- 升级先迁移副本/备份并检查 schema，失败保持只读；不得损坏原库后继续运行。

## 7. 核心设计决策

| 决策 | 原因 | 代价 |
|---|---|---|
| 三类 adapter 而非一个大接口 | 捕获、分析、消费可独立替换 | 更多显式配置 |
| 模型返回提案，不直接改权威库 | 易审计、易撤销、跨 Harness 统一 | 比 Hermes 的直接修改多一步 |
| SQLite 为权威来源，技能为投影 | 事务与并发控制可靠，投影可重建 | 需处理发布漂移 |
| 手动优先、能力驱动自动化 | 不编造宿主 hook 或权限隔离能力 | 不同宿主体验可能不同 |
| 插件空间自动写，用户空间需确认 | 防止破坏个人规则与项目约束 | 安装接入需要授权 |
| 核心无需专用服务器或向量库 | 易嵌入、易离线、易 Windows 部署 | 初期检索较简单 |
| 不承诺收益，不做研究 SI 的验收 | 保持任务经验组件的正确边界 | 仍需要用户纠错和维护 |
