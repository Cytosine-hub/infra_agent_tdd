# 运维需求交付门户

需求收集 → 组长审核 → AI 生成测试用例 → 双方审核 → Claude Code Agent 开发 → 测试 → GitHub CI/CD 的一体化工作流平台。设计文档见 [docs/DESIGN.md](docs/DESIGN.md)。

## 本地部署

```bash
npm install
npm run build
npm start          # 门户 Web（默认 http://localhost:3000）
npm run runner     # 本地 Agent 执行守护进程（另开终端/后台常驻）
# 开发模式：npm run dev + npm run runner
```

门户与 runner 是两个独立进程：门户只负责 Web 与任务入队，runner 负责执行用例生成/开发/审查任务——**重启门户不会中断进行中的 Agent 任务**。

无需任何外部配置即可运行：数据存在本地 SQLite（`./data/portal.db`），首次启动自动建表并写入各小组演示账号（组长/组员），登录页选择账号即可体验完整审批流。管理员登录后可在「设置」中维护目标仓库列表与账号/角色（组员、组长、管理员）。

## 可选配置（.env.local，参考 .env.example）

| 变量 | 作用 | 未配置时 |
|------|------|----------|
| `ANTHROPIC_API_KEY` | Claude 生成测试用例 | 本地模板生成兜底 |
| `AGENT_ENGINE` / `AGENT_TIMEOUT_MIN` | 本地 Agent 引擎（claude/codex）与超时 | claude / 30 分钟 |
| `GITHUB_TOKEN` | 启动开发时自动建 Issue、同步 PR 进度（一个 PAT 覆盖所有目标仓库） | 流程停在"待启动开发"并提示配置 |
| `GITHUB_REPOS` | 预置可绑定仓库列表（逗号分隔），也可在「仓库管理」页维护 | 在页面维护 |

## Agent 开发模式

**默认：本地 CLI 模式**（推荐，复用门户服务器上已登录的 Claude Code / Codex 客户端，不走 API 计费）：

- 门户服务器安装并登录 `claude`（或 `codex`）CLI 即可，目标仓库无需任何 Secret；
- 点「启动 Agent 开发」→ 建 Issue → 门户在独立工作区 clone、建分支 `feature/req-N-issue-M`、
  调用本地 CLI 测试先行开发 → 强制重跑测试 → push → 自动建 PR（`Closes #issue`）→ CI → 合并。

**可选：云端 Actions 模式**（团队有 Anthropic API Key 时）：拷贝 `github-templates/workflows/`
下的 `agent-develop.yml`（开发）与 `claude-pr-review.yml`（PR 审查）到目标仓库，配置
`ANTHROPIC_API_KEY` / `GH_PAT` Secrets，并创建 `agent:develop` 标签。

**每个目标仓库都需要**：

1. 根目录编写 `agent.md`（开发规范，参考 `github-templates/agent.md.example`），
   并放一行引导文件 `CLAUDE.md`/`AGENTS.md` 指向它。
2. 拷贝 `github-templates/workflows/ci.yml`（PR 强制测试，无需任何 Key）。
3. 分支保护规则:main 开启 required status checks（CI）与 **Merge Queue**。

## 测试

```bash
npm test    # vitest：状态机 / 双审逻辑 / 用例生成器
```

## 目录结构

```
src/lib/          # 领域层：状态机 workflow.ts、DB、测试用例生成、GitHub 编排
src/app/api/      # REST API（登录、需求 CRUD、工作流动作）
src/app/          # 页面：工作台看板、提交需求、需求详情（审批/用例编辑/时间线）
github-templates/ # 拷贝到各目标仓库的 GitHub Actions 与 agent.md 模板
docs/DESIGN.md    # 架构与设计决策
```
