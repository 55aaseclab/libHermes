# 工作记录

## 2026-10-15 · M0

- 建立三类 adapter 与统一核心的架构，经验管理不并入研究 SI。
- 实现合成轨迹 → 提案 → 显式批准 → SQLite → 托管技能 → 查询/撤销。
- 7 项测试、类型检查和 demo 通过。
- 不具备真实宿主、模型和自动后台集成。

## 2026-10-15 · OpenCode 手动接入与真实测试完成

- 用户授权接入 OpenCode 并进行实际测试。
- 本机 OpenCode 版本：1.18.35；计划手动导出/JSON 运行记录入口，不扫描历史会话。
- 首轮测试只发送合成证据，使用临时目录、禁工具的 reviewer，不更改用户配置。
- 保留明确的数据出口许可；外部模型并非本地 fake reviewer。

### 实现

- `OpenCodeExportHost`：只读显式导出，保留证据角色，拒绝混合会话和复盘会话。
- `OpenCodeReviewer`：独立临时目录运行、禁工具、JSON 提案、90 秒预算；需显式 allowNetwork。
- review / approve 两个 CLI 分离，默认不把提案直接变为 active skill。
- 12 项自动测试通过，TypeScript 检查通过。

### 真实测试

模型路由：`rpc2/deepseek-ai/DeepSeek-V4.1-Flash`。任务内容只包含“本项目先跑 focused unit tests，再跑完整测试”的合成用户纠正。

- 第一次 smoke 成功；早期脚本改写导出的 title 来区分源任务，后修正为创建源会话时就指定正确 title。
- 修正后重新完整运行，源会话 `ses_ec1644282ffegfAGgMXR21xHPS`，复盘会话 `ses_ec163a9c7ffeAS8KS2TcyH2LEn`。
- 复盘工具调用数 0；确认前 active items 为 0；显式批准后发布 revision 1。
- 完整产物：`/tmp/cl-opencode-smoke-qI86xh/`，含 source-export.json、proposal.json、result.json、learning.sqlite 和托管 SKILL.md。临时目录可能被系统清理。
- 独立 review CLI 再次处理该合成导出，得到 proposed / approved=false；独立 approve CLI 成功提交并发布至该目录的 manual-skills。

### 尚未验证

- 自动 idle/Stop hook 与后台常驻任务。
- 新任务中 OpenCode 原生发现、加载并使用发布技能。
- 技能对任务质量的收益、生产脱敏和 OS 级隔离。
- Windows/macOS；当前进程组终止仅在 Linux 验证。

## 2026-10-15 · 额度中断后复验

- 上次会话因模型 API 额度用尽中断；中断前代码与文档编辑均已落盘。
- 复验：TypeScript 检查、12 项测试、真实 smoke（`rpc/zai-org/GLM-5.3-Flash`，源会话 → 导出 → 复盘 → 提案 → 批准 → 发布，复盘工具调用 0）、手动 review CLI、独立 approve CLI 全部通过。
- 新发现并记录于 `opencode.md`：`opencode/` 免费模型在 CLI `--pure` 调用下返回 403 FreeTierError，只能用应用内；需换其他供应商路由。
- package.json 增加 `review:opencode` 与 `approve` 两个 npm script。

没有读取用户历史任务、安装全局插件或修改用户配置。OpenCode 自身会保存新建的合成任务与复盘会话，故不声称宿主状态完全无变化。

## 2026-10-15 · 真实多轮迷宫任务

三轮 OpenCode 制作迷宫 → 显式复盘 → 检查/批准四项经验 → 发布原生技能 → 新会话加载并添加 WASD。游戏 20 项测试、浏览器交互测试通过；组件 13 项测试与类型检查通过。

实验揭示并修复：cwd/PWD 漂移、大会话管道导出截断、临时指令错误长期化、长证据 ID 抄错及策略变更事件冲突。部分问题通过 prompt 改善并非正确性保证。详情、失败过程、会话 ID 和产物见 [迷宫实验](maze-experiment.md)。

目前已验证提示下的原生 skill 加载，不再仅限发布；自动 hook、无提示召回、因果收益仍未验证。
## 2026-10-15：补齐 OpenCode 自动闭环

实现 session.idle 自动捕获、持久队列、flock 串行 worker、工作区 policy 预授权提交和 system transform 自动注入。真实两个独立会话均自动触发并提交，第二个会话有自动注入审计，不要求用户加载 skill。记录见 `docs/opencode-auto.md`，成功产物 `/tmp/cl-auto-maze-20261015-c/result.json`。此前手动实验不能代表自动接入完成。
