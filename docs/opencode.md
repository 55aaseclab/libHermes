# OpenCode 手动接入

本次适配范围：显式选择一个会话导出 → 生成经验提案 → 人工检查 → 批准并发布。
不是自动 Stop/idle 插件，不扫描已有会话。测试版本为 OpenCode 1.18.35 / Node 22.22.1 / Linux。

## 1. 构建

```bash
npm ci --ignore-scripts
npm run build
npm test
```

## 2. 选择任务证据

在 OpenCode 中确定要复盘的会话 ID，显式导出：

```bash
opencode export --pure <session-id> > /your/private/task-export.json
```

导出会话应当只包含你希望分析的一项任务；当前版本不自动切割多任务会话。请先检查文件中的凭据、个人信息、源码和工具输出。`--sanitize` 可作为宿主提供的额外过滤选项，但不保证清除所有敏感信息，仍需人工检查。

适配器读取 message/part 中的用户文本、助手文本和工具调用结果，不读取 reasoning。未知附件/part 或未结束工具调用会标记为 partial；输出过大直接拒绝而不是静默截断。模型说“成功”仍保留为 assistant_message，不当作真实执行证明。

## 3. 生成提案

```bash
node dist/packages/cli/opencode-review.js \
  /your/private/task-export.json \
  /your/private/learning.sqlite \
  your-project-id \
  provider/model \
  --allow-network
```

数据库父目录须预先存在。项目 ID 使用字母、数字、下划线或短横线；不同项目不要复用同一 ID。`--allow-network` 明确允许把该导出及同 scope 的已有经验发送给指定模型。没有这个参数则拒绝；没有默认模型或静默模型 fallback。

命令输出 jobId、proposalDigest、proposal，**不自动批准、不发布技能**。同一导出、相同项目的重复执行会复用已有 job，避免重复模型调用。若任务已取消，不自动重启它。

## 4. 检查并批准

检查经验是否有适用条件、是否准确引用证据、是否混入秘密。确认后：

```bash
node dist/packages/cli/approve.js \
  /your/private/learning.sqlite \
  <job-id> \
  <proposal-digest> \
  /your/project/.opencode/skills \
  --approve
```

产物：`/your/project/.opencode/skills/continual-learning/SKILL.md`。只使用插件管理的独立子目录，不改 `AGENTS.md` 或其他技能。已有同名非托管文件会拒绝覆盖。安装路径是用户显式指定的；当前 CLI 不替用户推断或验证 workspace ID 与该路径的业务对应关系。

提交成功、发布失败时，数据库保留 outbox；修复路径问题后重跑相同批准命令即可重试。若托管文件被人工改过，会提示漂移，不会静默覆盖。

`no_change` 表示无值得保留的经验，不需要批准。当前提供库级历史/撤销 API，尚无完整交互管理界面。

## 5. 实际测试入口

```bash
CL_OPENCODE_MODEL=provider/model npm run test:opencode
```

该测试真实调用模型，可能产生费用：新建一个只有合成用户纠正的源会话，再用独立 reviewer 会话复盘。测试中的“批准”由测试代码模拟用户显式批准；正常 review CLI 不这样做。输出保留临时目录、源会话/复盘会话 ID、提案和发布文件。

模型选择注意：`opencode/` 前缀的免费模型（如 `opencode/step-5-preview-free`）在 CLI 管道调用下返回 403 FreeTierError，官方限制其只能在 OpenCode 应用内使用；`--pure` 运行需改用其他供应商路由（如 `rpc/` 系列）。进程失败时原始 stderr 不会打印，可先用极小 prompt 手动验证模型路由可用。

## 6. 权限与限制

- 使用 `opencode run --dir <temporary-dir> --pure --format json`，同时将环境 PWD 对齐，不继续主会话。该要求来自迷宫实验发现的实际目录漂移。
- 自定义 reviewer agent 禁工具，permission 全 deny，share disabled；检测到 tool_use 则丢弃结果。
- 模型只能输出 JSON 提案；由核心校验，reviewer 不拿数据库或发布目录。
- 工具禁用是宿主级约束，不是 OS 沙箱。OpenCode 进程仍使用用户配置/模型凭据，可能保存复盘会话；不声称零磁盘写入。
- 输入轨迹视为不可信数据；当前没有生产级脱敏，不适合敏感任务自动运行。
- `--pure` 用于禁外部插件，但不等于所有全局配置均不加载。
- 最大进程输出 2 MB，默认每次运行 90 秒；进程失败不把原始 stderr 直接打印，避免泄密。
- Linux 超时/取消会终止进程组；Windows 暂未验证进程树终止，不承诺同等隔离。
- 迷宫实验已验证新会话在明确提示下通过原生 skill 工具加载经验并完成后续修改；无提示发现和对质量的因果收益尚未验证。

多轮迷宫实验与后续验证见 [实验记录](maze-experiment.md)。对于大导出，库侧使用 `exportOpenCodeSession` 将 stdout 直接落临时普通文件并验证 JSON，避免本机 OpenCode 管道输出曾出现的截断；手动 CLI 的 `>` 重定向方式也使用普通文件。

源码入口：`packages/adapters/opencode/index.ts`、`packages/adapters/opencode/process.ts`。
官方 CLI 参考：https://opencode.ai/docs/cli/；配置参考：https://opencode.ai/docs/config/。
# 自动接入入口

自动生命周期插件现已实现，见 [opencode-auto.md](opencode-auto.md)。本文保留手动导出/复盘/审批流程，不能再用其中历史“无 hook”的描述代表当前全部能力。
