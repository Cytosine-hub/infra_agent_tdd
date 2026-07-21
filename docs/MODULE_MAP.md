# 模块地图 + 需求模块识别说明

## 1. 目标与边界

门户为每个目标仓库保存一张经维护者确认的模块地图。需求提交后，独立的 `classify` Agent 任务根据需求内容给出模块与允许路径建议；组长在评审阶段纠正并锁定范围。开发 Agent 启动时会收到该范围约束。

本增量只完成“地图候选 -> 人工确认 -> 需求识别 -> 人工锁定 -> 开发提示注入”。开发后按 git diff 自动拦截越界、模块地图自动刷新不在本增量。

## 2. 数据模型

`repo_modules` 每行代表仓库中的一个模块：

| 字段 | 含义 |
| --- | --- |
| `repo_id` | `repos.id` |
| `module_key` | 仓库内唯一的稳定 ASCII key |
| `name` | 展示名称，可使用“公共” |
| `paths` | JSON 字符串数组，元素为仓库相对路径 glob |
| `description` | 模块职责与边界 |
| `confirmed` | `0` 为 AI 候选/待确认，`1` 为维护者已确认 |
| `sort_order` | 展示顺序 |

模块地图的增、删、改会把该仓库全部模块重新置为 `confirmed=0`；“确认整张模块地图”一次性把所有行置为 `1`。因此不会出现一张地图只有部分行已确认的含糊状态。已确认地图在手动重新入驻时不会被 AI 覆盖。

`requirements` 新增：

| 字段 | 含义 |
| --- | --- |
| `module_key` | 人工确认的模块 key；多模块时以逗号分隔 |
| `scope_paths` | 人工锁定的允许路径 JSON 数组 |
| `module_suggestion` | `{moduleKey,rationale,confidence,scopePaths}` JSON |
| `scope_locked_by` | 锁定人用户名 |
| `scope_locked_at` | 锁定时间；非空也表示范围已锁定 |

迁移沿用 `db.ts` 的 `PRAGMA table_info` + 缺列 `ALTER TABLE` 方式；表使用 `CREATE TABLE IF NOT EXISTS`，可对已有库重复启动升级，新列均有兼容默认值。

## 3. 仓库入驻生成

`runRepoOnboard` 完成工作区准备、codegraph 索引与 agent.md 分析后，调用 `AGENT_ONBOARD_ENGINE`（默认 Claude CLI，与 agent.md 生成一致）分析真实目录、入口、codegraph 和仓库规范。

模型只返回模块候选 JSON 数组。解析层会：

- 把 `module_key` 规范为稳定的 kebab-case；
- 去重并拒绝绝对路径、协议 URL、`..` 等非仓库相对路径；
- 要求每个模块至少有名称和一个有效 glob；
- 将共享组件、平台基础设施等作为“公共”模块单列。

候选写入 `repo_modules` 且 `confirmed=0`。该步骤为 best-effort：失败只写服务日志，仓库仍进入 `ready`，维护者可在“设置 -> 仓库管理 -> 模块地图”手工补充。

## 4. 评审识别与确认

需求创建或被驳回后修改重提时，会和渲染图任务一起 best-effort 入队 `kind=classify`。默认引擎优先级为：

1. `AGENT_CLASSIFY_ENGINE`
2. `TESTCASE_ENGINE`
3. `codex`

runner 读取需求所属仓库的模块地图；存在已确认行时只使用已确认行，否则使用候选行。模型必须选择地图内的 `moduleKey`，给出理由、`0-1` 置信度与建议路径。未返回有效 `scopePaths` 时自动取所选模块的全部 paths。识别失败只将该辅助任务标为失败并记录时间线，不改变需求状态，也不阻塞用例或渲染图流程。

需求详情“模块归属”区域展示建议。开发启动前，本组组长或管理员可以：

- 选择或纠正一个模块；
- 选择多个模块表达显式跨模块交付；
- 编辑允许路径，并为公共代码增加额外路径授权；
- 确认后写入模块、路径、锁定人和时间。

锁定要求仓库模块地图已经整图确认。多模块选择会提示优先拆分需求；开发开始后 API 不允许再修改锁定范围，避免执行中的目标漂移。

## 5. 开发提示注入

`agent-runner.ts` 的 `buildPrompt` 在 `scope_locked_at` 非空且 `scope_paths` 有值时加入“已锁定开发范围”章节，包含：

- 归属模块 key（多模块为逗号分隔）；
- 逐条允许路径 glob；
- 范围外或公共代码改动必须明确说明、不得静默扩大的要求。

未锁定的存量需求不注入该章节，也不增加新的启动门禁，因此原有需求流程保持兼容。

## 6. API 与权限

- `GET/POST/PATCH/DELETE /api/repos/:id/modules`：列出、增加、编辑、确认、删除模块，仅组长/管理员。
- `PATCH /api/requirements/:id/scope`：锁定需求模块与允许路径，仅本组组长/管理员，且仅开发启动前可用。

所有写入路径都使用结构化 JSON 校验，并拒绝绝对路径和 `..`。本次路径校验只保证输入格式安全，不检查 glob 是否真实存在，也不对开发结果执行 diff 边界拦截。

## 7. 后续增量位置

### 路径边界硬校验

在 `agent-runner.ts` 开发任务完成、提交和 push 之前，以默认分支/修复基准执行 `git diff --name-only`，把文件列表与锁定的 `scope_paths` glob 匹配。越界时任务应停在新的范围审查步骤，记录越界文件，并由组长扩大授权或要求 Agent 回退。公共代码也走相同规则，不做隐式豁免。

### 模块地图自动刷新

在 `onboard.ts` 的候选生成能力上增加独立 refresh 任务，不直接覆盖已确认地图。建议触发源为目标仓库默认分支变更 webhook，评审时按索引时间做即时补偿，再加每日兜底扫描。刷新结果应保存为新候选版本，展示与当前已确认版本的 diff，由维护者确认后切换；需求已经锁定的历史范围不随地图版本自动变化。
