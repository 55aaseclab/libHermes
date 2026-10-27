# Adapter 契约与接入计划

状态：接口设计草案。本文中的类型是协议说明，不是已实现 SDK；方法名不是任何宿主的官方 API。

## 1. 协议原则

- 协议按 major/minor 版本化，拒绝不兼容 major；保留可忽略的 namespaced 扩展字段。
- Host ID 用 `codex`、`claude-code`、`deepseek-harness`、`opencode`，与模型供应商 ID 分开。
- 每个安装实例单独标识；同产品的 CLI、desktop、remote 不共用假定能力。
- 运行时探测优先于硬编码版本表。unknown 必须保留为 unknown，不能假装 supported。
- Core 不出现 `if host == "codex"` 式解析分支；差异留在 adapter。
- 采用 JSON Schema 校验输入、输出和持久化迁移，不只靠编译期类型。

## 2. 能力描述

```ts
type Support = "supported" | "unsupported" | "unknown";

interface HostCapabilities {
  protocolVersion: "1.0";
  adapterId: string;
  adapterVersion: string;
  hostVersion: string;
  installationId: string;
  surface: "cli" | "desktop" | "server" | "embedded";
  events: {
    taskStart: Support;
    taskEnd: Support;
    idle: Support;
    cancellation: Support;
    durableReplay: Support;
  };
  transcript: {
    transport: "api" | "file" | "supplied" | "none";
    stableCursor: Support;
    toolResults: Support;
  };
  consumption: {
    nativeSkills: Support;
    queryTool: Support;
    contextInjection: Support;
    refresh: "live" | "next_turn" | "next_session" | "unknown";
  };
  evidence: Array<{ capability: string; source: string; checkedAt: string }>;
}
```

`unsupported` 和 `unknown` 都不能启用需要该能力的自动流程。能力表是事实报告，不是通过/失败证书。

## 3. HostAdapter

```ts
interface HostAdapter {
  probe(): Promise<HostCapabilities>;
  resolveContext(nativeContext: unknown): Promise<ScopeBinding>;
  normalizeEvent(nativeEvent: unknown): Promise<LearningEvent | null>;
  capture(window: TaskWindow, signal: AbortSignal): Promise<EvidenceSnapshot>;
}
```

- `resolveContext` 映射经用户批准的 scope，不自行把所有仓库当作一个 workspace。
- `normalizeEvent` 不能把 idle 转译成 success，也不能把模型声明转成 tool evidence。
- `capture` 返回 schema version、稳定 end cursor、完整性标记、snapshot digest 和证据事件。
- 事件内不接受任意可读文件路径。file transport 只读注册会话根目录中经验证的轨迹文件。
- 宿主可推送事件，CLI 也可显式提交事件；二者调用同一核心 ingress。

`LearningEvent` 必填：event ID、host installation ID、session/task ID、kind、origin、timestamp、scope binding、cursor。支持 `origin=task|manual_review|continual_learning_review`，最后一种不再触发学习。

## 4. ReviewerAdapter

```ts
interface ReviewerAdapter {
  probe(): Promise<ReviewerCapabilities>;
  review(request: ReviewRequest, signal: AbortSignal): AsyncIterable<ReviewEvent>;
}
```

`ReviewRequest`：job ID、reviewer policy version、数据发送策略、证据包、相关经验及其 revision、输出 schema、token/时间预算。

`ReviewEvent`：started、usage、proposal、completed、failed。只有一个 final ProposalSet 可以提交；部分流式结果不可直接写库。

`ReviewerCapabilities` 至少报告：结构化输出、是否可禁工具、可限定工具白名单、取消、usage 可见性、是否会持久化输入、网络边界。无法符合用户数据策略时拒绝，不默默 fallback 到外部模型。

Reviewer 可以是普通模型请求，也可以是 Codex/Claude Code/OpenCode/DeepSeek Harness 的独立运行。HostAdapter 和 ReviewerAdapter 不互相硬依赖；同一个软件提供两种能力时分别注册。

使用 Harness reviewer 时，安装适配器不意味着允许该进程读整个用户目录。需要实际验证隔离；无法隔离则仅支持显式用户授权的手动复盘。

## 5. SkillPublisher

```ts
interface SkillPublisher {
  probe(binding: PublishBinding): Promise<PublisherCapabilities>;
  plan(snapshot: LearningSnapshot, binding: PublishBinding): Promise<PublishPlan>;
  apply(plan: PublishPlan, signal: AbortSignal): Promise<PublishReceipt>;
  inspect(binding: PublishBinding): Promise<ProjectionStatus>;
}
```

PublishPlan 包含 generation ID、只允许位于托管根目录内的相对路径、expected hash、新内容和删除清单。apply 必须验证 owner marker、路径和 expected hash。

- 删除清单只能包含同一 publisher 先前拥有的文件。
- 产物引用逻辑 LearningItem ID，不能只引用某台机器的绝对路径。
- 首次安装由用户选择全局或项目级可见性；不要静默默认全局。
- 不兼容的原生 skill 格式允许通过 query tool 消费，不能硬套 Markdown 就宣称兼容。
- 多个宿主目录是独立投影；只读、禁共享和 scope 绑定都应在 core 再检查一次。

## 6. 本地协议示例

以下是计划中的 IPC envelope，不是已存在的命令或 endpoint：

```json
{
  "protocol_version": "1.0",
  "request_id": "req-123",
  "method": "events.submit",
  "payload": {
    "event_id": "host-event-456",
    "installation_id": "codex-cli-local-1",
    "session_id": "session-7",
    "task_id": "task-9",
    "kind": "task_ended",
    "origin": "task",
    "completion": "unknown",
    "scope_binding_id": "workspace-binding-2",
    "end_cursor": "opaque-adapter-cursor",
    "timestamp": "2026-10-15T10:00:00Z"
  }
}
```

响应 receipt 只表示事件已持久化，不代表经验已生成或发布。计划中的应用服务方法：events.submit、reviews.start/get/cancel、proposals.approve/reject、items.query/history/revert、publishers.status/retry、adapters.doctor。

批处理 adapter 可以用 stdin/stdout JSONL 实现同一协议。标准输出只允许协议消息，日志写 stderr；限制帧大小、超时和进程权限。

## 7. 四个 Harness 的接入边界

### 7.1 Codex

拆成 CLI 与 desktop 两个 surface profile，不能把某端的 hooks 推断为全端通用。

- 安装形态：插件技能入口；必要时 MCP/本地桥接；CLI 可显式调用复盘。
- 自动触发：以当前版本的官方 lifecycle hook 支持和本地 probe 为准，缺失则手动或由授权的 wrapper 提交 task end。
- 轨迹：优先支持的结构化事件/输出；本地会话格式若没有稳定承诺，作为版本锁定的实验 reader，不全盘扫描用户历史。
- reviewer：评估非交互执行接口是否可满足权限和输出要求；仅“可以运行 codex exec”不等于可安全无人值守。
- 发布：插件托管 skill，或显式启用的检索工具；不自动修改用户 AGENTS.md。

已查阅的官方页面：
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/codex/noninteractive

文档曾将 lifecycle hooks 的可用性限制在特定安装形态；本设计不以此推出所有 Codex 运行面的支持情况。实现前须实际读取对应安装版本的 manifest/hook 文档并做端到端探测。

### 7.2 Claude Code

- 候选触发：官方 Stop / SessionEnd 等生命周期事件；两者语义不可混淆。
- hook 只做提交，不阻塞等待模型；重复 Stop 和停止 hook 引起的再次执行必须去重。
- 使用 hook 的 transcript 引用读取授权任务窗口；不捕获无关会话。
- 后台复盘使用新运行，不向主对话塞入隐藏 user message；禁复盘再次触发自动学习。
- 发布到独立托管 skill/plugin 空间，不自动修改 CLAUDE.md。
- Windows / shell 启动方式与可用异步机制需在测试矩阵验证。

官方入口：https://code.claude.com/docs/en/hooks

### 7.3 DeepSeek Harness

此处指 `deepseek-ai/deepseek-harness`，不是 DeepSeek 模型 API。用户确认的目标如为另一实现，新增 adapter，不把协议绑到供应商名称。

仓库快照：`571902028a75c64c1d767f4ae5fd099485f0ddf0`。

- 官方架构采用插件化扩展；已看到 durable `turn/end` 和 live `agent/turn-stopping` 等不同类型的事件。
- 候选方案：原生插件订阅已持久化任务/轮次完成信号，读取稳定会话快照。
- 不把 stopping 信号当作最终成功结果；不在有顺序约束的 stopping 链中运行长时间复盘。
- 确切订阅 API、读取权限、独立 review session 和技能加载接口留待插件 spike 验证；不编造与 Claude 同名的 hook。
- 原生发布不可用时，退化为显式检索/手动入口，不直接改框架内部状态。

来源：
- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/docs/architecture.md
- https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/docs/agent-lifecycle.md

### 7.4 OpenCode

- 候选触发：plugin event 中的会话 idle 等事件；先防抖再读取稳定结束 cursor。
- 轨迹优先通过 SDK/session API 获取；adapter 负责 message part → 统一 EvidenceEvent。
- 若通过独立会话复盘，带 origin 标记并从观测器中排除，不观察自己产生的 review 会话。
- session ID 可以持久化，但不能认为进程重启后流游标仍有效；恢复时重新建立 cursor 并去重。
- 插件 SDK 版本和事件字段通过 fixture/contract test 锁定。

官方入口：https://opencode.ai/docs/plugins/

## 8. 能力降级矩阵

| 缺少能力 | 允许的体验 | 禁止行为 |
|---|---|---|
| task-end hook | 手动复盘、用户启动 wrapper | 宣称自动触发 |
| 稳定完整轨迹 | 用户提供材料，标记部分证据 | 将缺失结果猜成成功 |
| 受限后台 runner | 手动确认后执行、使用合规替代 reviewer | 静默放宽主 Agent 的权限 |
| 原生技能发现 | 显式查询工具或手动加载 | 偷改宿主 system prompt |
| token/cost 统计 | 时间/轮次预算，费用 unknown | 伪造精确成本 |
| live refresh | 下次会话生效，提示用户 | 承诺当前会话立即掌握 |

## 9. 新增第五个 Harness 的最小工作

1. 实现 probe、事件归一化、上下文绑定、证据读取。
2. 提供固定版本的脱敏 fixtures 和异常输入样本。
3. 复用或新增 publisher；无原生技能则使用查询工具。
4. 只有需要该宿主执行复盘时才新增 ReviewerAdapter。
5. 跑契约测试；记录 capabilities 与已知降级。

若新增 adapter 需要改写 core 的提炼 prompt、写入事务或冲突算法，说明边界设计失效，应先修接口而不是加厂商分支。
