# Continual Learning

一个给现有任务 Agent 使用的、跨 Harness 的经验管理组件。

**当前状态：本地原型 + OpenCode 自动 hook / 手动接入。** 自动插件支持任务回合结束后复盘、按工作区预授权发布、后续请求注入经验。尚无常驻 daemon 或发布的 npm 包，其他宿主的自动插件尚未实现。

OpenCode 操作方法见 [自动接入指南](docs/opencode-auto.md) 和 [手动接入指南](docs/opencode.md)，里程碑和真实测试记录见 [工作记录](docs/progress.md)。

## 运行原型

要求 Node.js 22.13+，使用内置 `node:sqlite`（当前测试环境 Node 22 会显示实验特性警告）。

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run demo
```

demo 使用合成证据与固定 FakeReviewer，在系统临时目录创建数据库和托管技能，展示确认前零写入、发布、查询、修订与撤销；不安装宿主插件、不调用模型、不修改用户配置。为演示方便，确认由 demo 显式代码执行，不是交互审批界面。

已实现：JSON Schema 校验、scope 检查、事件去重、证据来源引用、显式提案批准、SQLite 事务/CAS/历史、FTS 查询、持久发布 outbox、单文件原子发布与人工修改检测。

原型限制：支持 fixture 和显式 OpenCode 会话导出；能力声明不是安全沙箱。OpenCode reviewer 禁止工具并使用临时目录，但沿用本机配置与凭据，不提供 OS 沙箱，也可能在 OpenCode 的会话存储中持久化输入。尚无敏感数据扫描、自动执行队列、lease、自动 stale-lock 恢复、多文件发布或自动宿主安装。发布锁只协调本组件，路径检查不是抵抗同用户恶意并发文件替换的安全边界。全流程只在当前 Linux 环境测试，Windows/macOS 尚未验证。请勿用于敏感生产轨迹。

接口：`packages/protocol/types.ts`；入口：`packages/core/core.ts`；演示：`examples/demo.ts`。M0 暂时使用一个根 package，目录边界保持独立，待真实 adapter 验证后再拆分发布包。

## 产品边界

用户继续用 Codex、Claude Code、DeepSeek Harness 或 OpenCode 做任务。本组件负责从任务证据中整理经验，在相关任务中提供经验，并允许查看、修订和撤销。

它不替代任务 Agent，不负责 PoC 生成策略，不修改模型权重，也不充当研究项目中的 SI/RSI 验收框架。这里的写入检查是数据完整性、权限和证据检查，**不是能力增长证明**。

## 一套核心，多个适配器

```text
Codex / Claude Code / DeepSeek Harness / OpenCode
                  │ HostAdapter：事件、轨迹、任务上下文
                  ▼
       统一任务证据 → 核心经验整理 → 版本化经验库
                          │                  │
             ReviewerAdapter                │ SkillPublisher
           只读复盘并返回提案                 ▼
                                 Harness 可读取的托管技能
```

重要的是三个角色可以独立组合：**谁产生经验、谁分析经验、谁使用经验不必是同一个 Harness**。宿主导出的证据必须先通过本地数据策略，才能发送给另一个分析后端。

## 阅读顺序

1. [架构与设计决策](docs/architecture.md)：边界、数据模型、执行流程、并发、安全和生命周期。
2. [Adapter 契约](docs/adapter-contracts.md)：插件接口、四个 Harness 的接入计划、能力降级和协议示例。
3. [交付与验证计划](docs/delivery.md)：分阶段范围、契约测试、成功标准和未决事项。

## 第一版范围

- 单机、单用户、多项目；本地经验库为权威来源。
- 手动复盘优先，自动复盘按宿主能力与用户授权启用。
- 保存用户明确纠正、可复用流程、环境事实和有适用条件的失败经验。
- 默认输出修改提案供用户确认；自动模式仅写插件自己管理的空间。
- 支持来源追踪、检索、版本差异、冲突、撤销和敏感数据过滤。
- 不引入远程服务、向量数据库、多 Agent 委员会或自动 Benchmark 优化。

## 设计约定

- `HostAdapter` 适配宿主，不承载经验提炼算法。
- `ReviewerAdapter` 适配分析执行方式，不拥有权威存储写权限。
- `SkillPublisher` 适配宿主的技能格式和发现方式，不修改用户手写规则。
- 没有 hook 的宿主仍能通过手动入口使用；没有可靠轨迹的宿主不能伪装成完整自动学习。
- 托管技能是可重建的发布产物，不是第二个可任意修改的真相源。
- 所有自动复盘都带来源标记、预算和禁递归策略。

设计与来源检查日期：2026-10-15。各宿主接口可能变化；实现时仍必须验证安装版本，而不是依赖日期猜测能力。
