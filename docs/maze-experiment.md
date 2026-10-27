# 多轮迷宫任务实验（完成）

目标：验证实际任务轨迹进入 continual learning，再在全新 OpenCode 会话中通过原生 skill 工具加载发布产物。不是比较能力提升率，也不是自动 hook 测试。

模型：`rpc2/deepseek-ai/DeepSeek-V4.1-Flash`；OpenCode 1.18.35；Linux。

任务由本项目测试驱动创建，用户纠正属于实验中给定的项目要求，不冒充自然用户研究数据。游戏实现和工具结果由 OpenCode 实际产生。

## 复现入口

```bash
npm run build
CL_OPENCODE_MODEL=provider/model CL_MAZE_ROOT=/your/test/root node dist/examples/opencode-maze.js
```

顺序三轮：创建纯 HTML/JS 迷宫及测试；修正碰墙/计步/通关/重置约定；增加屏幕按钮并统一移动逻辑。保存每轮原始 JSONL 和完成状态。支持从已成功完成轮次恢复，但超时中途的会话不自动重用，避免重复写入的不确定性。

接着用手动复盘 CLI 处理 `artifacts/source-export.json`，检查并批准提案，发布到 `game/.opencode/skills/`。最后执行：

```bash
CL_OPENCODE_MODEL=provider/model CL_MAZE_ROOT=/your/test/root node dist/examples/opencode-maze-reuse.js
```

复用测试明确要求新会话发现/加载相关技能，再添加 WASD。它验证的是有提示的原生加载与任务使用，不声称无提示自动检索或因果收益。

## 首次运行发现的问题

本机 OpenCode 运行时仅传 subprocess cwd 不足：继承的 PWD 指向组件目录，源会话实际也记录为组件目录。游戏文件因此错误创建在组件目录中。已停止该运行，将本轮新建的 game.mjs、app.mjs、index.html、styles.css、tests/game.test.mjs 移入旧实验目录；组件 README 未被改写。该轮不算隔离实验成功。

修复：进程 runner 将 PWD 与 cwd 对齐，同时所有 OpenCode run 显式指定 `--dir`。添加回归断言，检查进程 cwd 和环境 PWD 相同。新实验使用全新根目录 `/tmp/cl-maze-20261015-fixed`；源会话 metadata 已确认 directory 为其中的 game 目录。

这也修正了此前 reviewer 临时 cwd 的实现假设；此前禁工具仍有效，但不能据旧测试声称运行目录隔离已被验证。

## 实际任务完成

修复后的源会话：`ses_ec0ddc238ffeAD26eg4TtrDm89`。三轮分别产生 10、11、9 个工具事件。第三轮结束后独立运行 15 个游戏测试全部通过。

额外用真实 Chromium headless 浏览器执行：渲染、碰墙不计步、12 步键盘解迷、通关后锁定、Restart、屏幕方向按钮。全部通过，页面异常为 0；截图在实验目录 `artifacts/maze.png`。

## 暴露的真实问题

1. 大会话 `opencode export` 走 pipe 时本机曾返回被截断的 JSON（退出码却为 0）。新增 `exportOpenCodeSession` 将 stdout 直接写入临时普通文件，再检查大小与解析 JSON。已用该会话重跑导出通过，不接受截断文件。
2. 初次复盘产生六条经验，其中把临时的“不要创建 skills yet”误写为长期约束，并将 DOM 转发函数误称纯函数。这份提案未批准，原 job 已取消。加强复盘 prompt 排除临时任务编排和测试权限，不把用户的架构要求扩写为错误代码事实；重新复盘保留旧提案用于对照。

这表明结构化 schema 和证据引用并不保证语义正确，人工确认阶段确实必要。修正 prompt 后重跑不是一次独立成功样本，也不声称提炼已可靠。

3. 第二版复盘先在 90 秒超时，增加本次实验预算到 180 秒后又因未知证据 ID 被核心拒绝。改为给模型短别名 E1/E2，返回后严格映射到原始证据 ID，不宽松匹配、不接受编造引用。
4. 更换策略版本重新提交同一 export 暴露 eventId 冲突；修复为 eventId 包含 scope、task 和 policyVersion，增加契约测试。Reviewer prompt 策略版本现为 opencode-review-v3。

## 成功结果

最终提案 `artifacts/review-v3.json` 包含四项：

- maze-game-rules：碰墙不计步、通关锁定、重置状态。
- maze-single-move-fn：键盘和屏幕按钮走同一纯逻辑，不在 DOM 重写规则。
- maze-test-workflow：先回归测试，再实现，focused 测试后全量测试。
- maze-shell-restriction：本实验环境的 shell 限制，仅用于当前 scope，不可推广为普遍开发约定。

由本次实验操作者检查后批准，未批准最初的有问题版本。技能发布到 `game/.opencode/skills/continual-learning/SKILL.md`。

新会话 `ses_ec0d19f80ffetNCshSL1YPwdz1`（不同于源会话）通过原生 `skill` 工具成功加载该 skill 一次，随后完成 WASD 改动。轨迹记录 24 个工具事件；行为上先编辑测试，再实现 directionForKey 并经同一 tryMove 链路移动，执行 focused tests 后执行全量 tests。

独立验证：20 个游戏测试通过；浏览器键盘移动、碰墙、12 步解迷、通关锁定、重置、方向按钮和 WASD 通过，页面异常为零。Agent 最终自然语言曾称“4 new, 16 existing”，实际由 15 增至 20，应以测试文件/运行结果为准，不采用这段错误口头计数。

组件自身：13 项测试和类型检查通过。新增导出读取器使用该真实 161 KB 轨迹验证通过；并未做全面故障注入测试。

## 证据和局限

- 全部实验根目录：`/tmp/cl-maze-20261015-fixed`；游戏：`game/`；截图：`artifacts/maze.png`。
- 轨迹：round-1/2/3.jsonl、source-export.json、reuse.jsonl、reuse-export.json。
- 结果：review.json（最初被否决）、review-v3.json、reuse-result.json、browser-result.json、game-tests-after-reuse.txt。
- 学习触发仍为显式复盘命令，不是自动 hook；新会话被明确提示查找技能，不是无提示召回实验。
- 没有对照组，不能把通过测试归因于经验学习带来的能力提升；已验证的是跨会话提炼、发布、原生加载和有迹可查的使用。
- 初次目录漂移、截断、超时与坏引用均已披露；不把多次修正包装成一次成功。
- 临时文件可能被系统清理；复现驱动代码保存在 examples/opencode-maze.ts 和 examples/opencode-maze-reuse.ts。
