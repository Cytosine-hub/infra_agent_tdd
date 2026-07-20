import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import type { Repo, Requirement, RequirementEvent, TestCase, User } from "./types";
import { DEFAULT_PASSWORD, hashPassword, verifyPassword } from "./password";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new DatabaseSync(path.join(DATA_DIR, "portal.db"));
  _db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      team TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      team TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'P1',
      description TEXT NOT NULL,
      test_scenarios TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'submitted',
      created_by TEXT NOT NULL,
      test_cases TEXT,
      lead_approved_tests INTEGER NOT NULL DEFAULT 0,
      requester_approved_tests INTEGER NOT NULL DEFAULT 0,
      github_issue_number INTEGER,
      github_issue_url TEXT,
      branch TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      reject_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      team TEXT NOT NULL DEFAULT '',
      onboard_status TEXT NOT NULL DEFAULT 'ready',
      onboard_step TEXT NOT NULL DEFAULT '',
      onboard_error TEXT NOT NULL DEFAULT '',
      onboard_pr TEXT NOT NULL DEFAULT '',
      indexed_at TEXT,
      token TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT 'github.com'
    );
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'develop',
      engine TEXT NOT NULL DEFAULT 'claude',
      model TEXT NOT NULL DEFAULT '',
      effort TEXT NOT NULL DEFAULT '',
      fallback INTEGER NOT NULL DEFAULT 0,
      extra TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      result TEXT,
      step TEXT NOT NULL DEFAULT '',
      error TEXT,
      pid INTEGER,
      log_path TEXT NOT NULL DEFAULT '',
      workspace TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      uploaded_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);
  migrate(_db);
  seedUsers(_db);
  seedRepos(_db);
  seedTeams(_db);
  return _db;
}

// 轻量迁移：老库补列
function migrate(d: DatabaseSync) {
  const cols = d.prepare("PRAGMA table_info(requirements)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "repo")) {
    d.exec("ALTER TABLE requirements ADD COLUMN repo TEXT NOT NULL DEFAULT ''");
  }
  const ucols = d.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!ucols.some((c) => c.name === "provider")) {
    d.exec("ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'");
    d.exec("ALTER TABLE users ADD COLUMN provider_login TEXT NOT NULL DEFAULT ''");
  }
  // 老库补密码列，并给已有内置账号设默认密码（第三方账号不设，走 OAuth）
  if (!ucols.some((c) => c.name === "password_hash")) {
    d.exec("ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''");
    const locals = d
      .prepare("SELECT id FROM users WHERE provider = 'local' AND password_hash = ''")
      .all() as { id: number }[];
    const upd = d.prepare("UPDATE users SET password_hash = ? WHERE id = ?");
    for (const u of locals) upd.run(hashPassword(DEFAULT_PASSWORD), u.id);
  }
  const tcols = d.prepare("PRAGMA table_info(agent_tasks)").all() as { name: string }[];
  if (tcols.length > 0 && !tcols.some((c) => c.name === "model")) {
    d.exec("ALTER TABLE agent_tasks ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    d.exec("ALTER TABLE agent_tasks ADD COLUMN effort TEXT NOT NULL DEFAULT ''");
  }
  if (tcols.length > 0 && !tcols.some((c) => c.name === "kind")) {
    d.exec("ALTER TABLE agent_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'develop'");
    d.exec("ALTER TABLE agent_tasks ADD COLUMN result TEXT");
  }
  if (tcols.length > 0 && !tcols.some((c) => c.name === "beat_at")) {
    d.exec("ALTER TABLE agent_tasks ADD COLUMN beat_at TEXT NOT NULL DEFAULT ''");
  }
  if (tcols.length > 0 && !tcols.some((c) => c.name === "fallback")) {
    d.exec("ALTER TABLE agent_tasks ADD COLUMN fallback INTEGER NOT NULL DEFAULT 0");
  }
  if (tcols.length > 0 && !tcols.some((c) => c.name === "extra")) {
    d.exec("ALTER TABLE agent_tasks ADD COLUMN extra TEXT NOT NULL DEFAULT ''");
  }
  d.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')");
  const rcols = d.prepare("PRAGMA table_info(requirements)").all() as { name: string }[];
  if (!rcols.some((c) => c.name === "exec_plan")) {
    d.exec("ALTER TABLE requirements ADD COLUMN exec_plan TEXT");
  }
  if (!rcols.some((c) => c.name === "guard_status")) {
    d.exec("ALTER TABLE requirements ADD COLUMN guard_status TEXT NOT NULL DEFAULT ''");
    d.exec("ALTER TABLE requirements ADD COLUMN guard_reason TEXT NOT NULL DEFAULT ''");
  }
  if (!rcols.some((c) => c.name === "review_verdict")) {
    d.exec("ALTER TABLE requirements ADD COLUMN review_verdict TEXT NOT NULL DEFAULT ''");
    d.exec("ALTER TABLE requirements ADD COLUMN review_feedback TEXT NOT NULL DEFAULT ''");
    d.exec("ALTER TABLE requirements ADD COLUMN fix_rounds INTEGER NOT NULL DEFAULT 0");
  }
  const pcols = d.prepare("PRAGMA table_info(repos)").all() as { name: string }[];
  if (pcols.length > 0 && !pcols.some((c) => c.name === "team")) {
    d.exec("ALTER TABLE repos ADD COLUMN team TEXT NOT NULL DEFAULT ''");
  }
  // 老仓库默认 ready（已在用，不强制重新入驻）；新加的仓库由 addRepo 显式置 pending
  if (pcols.length > 0 && !pcols.some((c) => c.name === "onboard_status")) {
    d.exec("ALTER TABLE repos ADD COLUMN onboard_status TEXT NOT NULL DEFAULT 'ready'");
    d.exec("ALTER TABLE repos ADD COLUMN onboard_step TEXT NOT NULL DEFAULT ''");
    d.exec("ALTER TABLE repos ADD COLUMN onboard_error TEXT NOT NULL DEFAULT ''");
    d.exec("ALTER TABLE repos ADD COLUMN onboard_pr TEXT NOT NULL DEFAULT ''");
    d.exec("ALTER TABLE repos ADD COLUMN indexed_at TEXT");
  }
  if (pcols.length > 0 && !pcols.some((c) => c.name === "token")) {
    d.exec("ALTER TABLE repos ADD COLUMN token TEXT NOT NULL DEFAULT ''");
    d.exec("ALTER TABLE repos ADD COLUMN host TEXT NOT NULL DEFAULT 'github.com'");
  }
}

// 支持用环境变量预置仓库列表（逗号分隔 owner/repo），也可在设置页维护
function seedRepos(d: DatabaseSync) {
  const seeds = (process.env.GITHUB_REPOS ?? process.env.GITHUB_REPO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ins = d.prepare("INSERT OR IGNORE INTO repos (full_name) VALUES (?)");
  for (const s of seeds) ins.run(s);
}

// 首次启动写入演示账号；生产环境应替换为 LDAP/SSO
function seedUsers(d: DatabaseSync) {
  const count = d.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number };
  if (count.c > 0) return;
  const ins = d.prepare(
    "INSERT INTO users (username, display_name, role, team, password_hash) VALUES (?, ?, ?, ?, ?)"
  );
  const pw = () => hashPassword(DEFAULT_PASSWORD);
  ins.run("admin", "平台管理员", "admin", "平台", pw());
  ins.run("db_lead", "数据库组组长", "lead", "数据库组", pw());
  ins.run("db_member", "数据库组组员", "member", "数据库组", pw());
  ins.run("mw_lead", "中间件组组长", "lead", "中间件组", pw());
  ins.run("mw_member", "中间件组组员", "member", "中间件组", pw());
  ins.run("host_lead", "主机组组长", "lead", "主机组", pw());
  ins.run("net_lead", "网络组组长", "lead", "网络组", pw());
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToRequirement(r: any): Requirement {
  return {
    id: r.id,
    title: r.title,
    team: r.team,
    repo: r.repo ?? "",
    priority: r.priority,
    description: r.description,
    testScenarios: r.test_scenarios,
    status: r.status,
    createdBy: r.created_by,
    testCases: r.test_cases ? (JSON.parse(r.test_cases) as TestCase[]) : null,
    leadApprovedTests: r.lead_approved_tests,
    requesterApprovedTests: r.requester_approved_tests,
    githubIssueNumber: r.github_issue_number,
    githubIssueUrl: r.github_issue_url,
    branch: r.branch,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    rejectReason: r.reject_reason,
    execPlan: r.exec_plan ? JSON.parse(r.exec_plan) : null,
    guardStatus: r.guard_status ?? "",
    guardReason: r.guard_reason ?? "",
    reviewVerdict: r.review_verdict ?? "",
    reviewFeedback: r.review_feedback ?? "",
    fixRounds: r.fix_rounds ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listRequirements(): Requirement[] {
  const rows = db().prepare("SELECT * FROM requirements ORDER BY id DESC").all();
  return rows.map(rowToRequirement);
}

export function getRequirement(id: number): Requirement | null {
  const row = db().prepare("SELECT * FROM requirements WHERE id = ?").get(id);
  return row ? rowToRequirement(row) : null;
}

export function createRequirement(input: {
  title: string;
  team: string;
  repo: string;
  priority: string;
  description: string;
  testScenarios: string;
  createdBy: string;
}): Requirement {
  const res = db()
    .prepare(
      `INSERT INTO requirements (title, team, repo, priority, description, test_scenarios, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.title,
      input.team,
      input.repo,
      input.priority,
      input.description,
      input.testScenarios,
      input.createdBy
    );
  const id = Number(res.lastInsertRowid);
  addEvent(id, "created", input.createdBy, "提交需求");
  return getRequirement(id)!;
}

export function updateRequirement(id: number, patch: Record<string, unknown>) {
  const colMap: Record<string, string> = {
    status: "status",
    title: "title",
    team: "team",
    repo: "repo",
    priority: "priority",
    description: "description",
    testScenarios: "test_scenarios",
    testCases: "test_cases",
    leadApprovedTests: "lead_approved_tests",
    requesterApprovedTests: "requester_approved_tests",
    githubIssueNumber: "github_issue_number",
    githubIssueUrl: "github_issue_url",
    branch: "branch",
    prNumber: "pr_number",
    prUrl: "pr_url",
    rejectReason: "reject_reason",
    execPlan: "exec_plan",
    guardStatus: "guard_status",
    guardReason: "guard_reason",
    reviewVerdict: "review_verdict",
    reviewFeedback: "review_feedback",
    fixRounds: "fix_rounds",
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = colMap[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    vals.push((k === "testCases" || k === "execPlan") && v !== null ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now', 'localtime')");
  db()
    .prepare(`UPDATE requirements SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]), id);
}

export function addEvent(requirementId: number, type: string, actor: string, detail = "") {
  db()
    .prepare("INSERT INTO events (requirement_id, type, actor, detail) VALUES (?, ?, ?, ?)")
    .run(requirementId, type, actor, detail);
}

export function listEvents(requirementId: number): RequirementEvent[] {
  const rows = db()
    .prepare("SELECT * FROM events WHERE requirement_id = ? ORDER BY id ASC")
    .all(requirementId) as any[];
  return rows.map((r) => ({
    id: r.id,
    requirementId: r.requirement_id,
    type: r.type,
    actor: r.actor,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

// 首次启动预置默认小组；之后由管理员在「小组管理」维护
function seedTeams(d: DatabaseSync) {
  const count = d.prepare("SELECT COUNT(*) AS c FROM teams").get() as { c: number };
  if (count.c > 0) return;
  const ins = d.prepare("INSERT OR IGNORE INTO teams (name) VALUES (?)");
  for (const t of ["数据库组", "中间件组", "主机组", "网络组"]) ins.run(t);
}

export function listTeams(): { id: number; name: string }[] {
  return db().prepare("SELECT * FROM teams ORDER BY id").all() as { id: number; name: string }[];
}

export function teamExists(name: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM teams WHERE name = ?").get(name));
}

export function addTeam(name: string): { id: number; name: string } {
  db().prepare("INSERT OR IGNORE INTO teams (name) VALUES (?)").run(name);
  return db().prepare("SELECT * FROM teams WHERE name = ?").get(name) as {
    id: number;
    name: string;
  };
}

// 小组被账号或需求引用时不允许删除
export function teamUsage(name: string): { users: number; requirements: number } {
  const u = db().prepare("SELECT COUNT(*) AS c FROM users WHERE team = ?").get(name) as {
    c: number;
  };
  const r = db().prepare("SELECT COUNT(*) AS c FROM requirements WHERE team = ?").get(name) as {
    c: number;
  };
  return { users: u.c, requirements: r.c };
}

export function deleteTeam(id: number) {
  db().prepare("DELETE FROM teams WHERE id = ?").run(id);
}

export function getTeamById(id: number): { id: number; name: string } | null {
  return (
    (db().prepare("SELECT * FROM teams WHERE id = ?").get(id) as {
      id: number;
      name: string;
    }) ?? null
  );
}

export function repoExists(fullName: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM repos WHERE full_name = ?").get(fullName));
}

function rowToRepo(r: any): Repo {
  return {
    id: r.id,
    fullName: r.full_name,
    description: r.description,
    team: r.team ?? "",
    onboardStatus: r.onboard_status ?? "ready",
    onboardStep: r.onboard_step ?? "",
    onboardError: r.onboard_error ?? "",
    onboardPr: r.onboard_pr ?? "",
    indexedAt: r.indexed_at ?? null,
    hasToken: Boolean(r.token),
    host: r.host ?? "github.com",
  };
}

// 内部使用：取仓库的原始 token（供 clone/push/API 认证，不经 API 暴露给前端）
export function getRepoToken(fullName: string): string {
  const r = db().prepare("SELECT token FROM repos WHERE full_name = ?").get(fullName) as
    | { token: string }
    | undefined;
  return r?.token ?? "";
}

export function setRepoToken(id: number, token: string) {
  db().prepare("UPDATE repos SET token = ? WHERE id = ?").run(token, id);
}

export function listRepos(): Repo[] {
  const rows = db().prepare("SELECT * FROM repos ORDER BY full_name").all() as any[];
  return rows.map(rowToRepo);
}

export function getRepoByName(fullName: string): Repo | null {
  const r = db().prepare("SELECT * FROM repos WHERE full_name = ?").get(fullName) as any;
  return r ? rowToRepo(r) : null;
}

export function addRepo(
  fullName: string,
  description = "",
  team = "",
  token = "",
  host = "github.com"
): Repo {
  // 新加仓库置 pending，由 runner 后台入驻（clone + codegraph 索引 + agent.md）
  db()
    .prepare(
      "INSERT OR IGNORE INTO repos (full_name, description, team, token, host, onboard_status) VALUES (?, ?, ?, ?, ?, 'pending')"
    )
    .run(fullName, description, team, token, host);
  return getRepoByName(fullName)!;
}

// 取仓库 host（clone/push 用）
export function getRepoHost(fullName: string): string {
  const r = db().prepare("SELECT host FROM repos WHERE full_name = ?").get(fullName) as
    | { host: string }
    | undefined;
  return r?.host ?? "github.com";
}

export function getRepoById(id: number): Repo | null {
  const r = db().prepare("SELECT * FROM repos WHERE id = ?").get(id) as any;
  return r ? rowToRepo(r) : null;
}

export function updateRepoOnboard(
  id: number,
  patch: Partial<{
    onboardStatus: string;
    onboardStep: string;
    onboardError: string;
    onboardPr: string;
    indexedAt: string;
  }>
) {
  const colMap: Record<string, string> = {
    onboardStatus: "onboard_status",
    onboardStep: "onboard_step",
    onboardError: "onboard_error",
    onboardPr: "onboard_pr",
    indexedAt: "indexed_at",
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!colMap[k]) continue;
    sets.push(`${colMap[k]} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  db()
    .prepare(`UPDATE repos SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]), id);
}

// runner 认领下一个待入驻仓库（置 indexing，避免重复认领）
export function claimNextPendingRepo(): Repo | null {
  const r = db()
    .prepare("SELECT * FROM repos WHERE onboard_status = 'pending' ORDER BY id ASC LIMIT 1")
    .get() as any;
  if (!r) return null;
  db().prepare("UPDATE repos SET onboard_status = 'indexing', onboard_step = 'queued' WHERE id = ?").run(r.id);
  return getRepoById(r.id);
}

// 标记 pending 状态供 runner 认领（手动重新入驻用）
export function requeueRepoOnboard(id: number) {
  db()
    .prepare(
      "UPDATE repos SET onboard_status = 'pending', onboard_step = '', onboard_error = '' WHERE id = ?"
    )
    .run(id);
}

export function deleteRepo(id: number) {
  db().prepare("DELETE FROM repos WHERE id = ?").run(id);
}

function rowToUser(r: any): User {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    team: r.team,
    provider: r.provider ?? "local",
    providerLogin: r.provider_login ?? "",
  };
}

/* ---------- 本地 Agent 任务 ---------- */

export type AgentTaskKind = "develop" | "review" | "testcases" | "mockup";

export interface AgentTaskRow {
  id: number;
  requirementId: number;
  kind: AgentTaskKind;
  engine: string;
  model: string;
  effort: string;
  fallback: 0 | 1; // 额度受限时是否自动切换备用引擎重试
  extra: string; // 重新生成时的补充要求（用例/渲染图）
  result: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  step: string;
  beatAt: string; // 最近活性时间戳（epoch ms 字符串），由 runner 心跳刷新
  error: string | null;
  pid: number | null;
  logPath: string;
  workspace: string;
  createdAt: string;
  finishedAt: string | null;
}

function rowToTask(r: any): AgentTaskRow {
  return {
    id: r.id,
    requirementId: r.requirement_id,
    kind: r.kind ?? "develop",
    engine: r.engine,
    model: r.model ?? "",
    effort: r.effort ?? "",
    fallback: r.fallback ?? 0,
    extra: r.extra ?? "",
    result: r.result,
    status: r.status,
    step: r.step,
    beatAt: r.beat_at ?? "",
    error: r.error,
    pid: r.pid,
    logPath: r.log_path,
    workspace: r.workspace,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export function createAgentTask(
  requirementId: number,
  engine: string,
  model = "",
  effort = "",
  kind: AgentTaskKind = "develop",
  fallback: 0 | 1 = 0,
  extra = ""
): AgentTaskRow {
  const res = db()
    .prepare(
      "INSERT INTO agent_tasks (requirement_id, engine, model, effort, kind, fallback, extra) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(requirementId, engine, model, effort, kind, fallback, extra);
  return getAgentTask(Number(res.lastInsertRowid))!;
}

export function getAgentTask(id: number): AgentTaskRow | null {
  const r = db().prepare("SELECT * FROM agent_tasks WHERE id = ?").get(id);
  return r ? rowToTask(r) : null;
}

export function latestAgentTask(
  requirementId: number,
  kind: AgentTaskKind = "develop"
): AgentTaskRow | null {
  const r = db()
    .prepare(
      "SELECT * FROM agent_tasks WHERE requirement_id = ? AND kind = ? ORDER BY id DESC LIMIT 1"
    )
    .get(requirementId, kind);
  return r ? rowToTask(r) : null;
}

export function listActiveAgentTasks(): AgentTaskRow[] {
  const rows = db()
    .prepare("SELECT * FROM agent_tasks ORDER BY id DESC LIMIT 50")
    .all() as any[];
  return rows.map(rowToTask);
}

// 守护进程认领下一个排队任务（单 runner 场景，无并发竞争）
export function claimNextQueuedTask(): AgentTaskRow | null {
  const r = db()
    .prepare("SELECT * FROM agent_tasks WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
    .get();
  if (!r) return null;
  const task = rowToTask(r);
  db()
    .prepare("UPDATE agent_tasks SET status = 'running', step = 'claimed' WHERE id = ?")
    .run(task.id);
  return getAgentTask(task.id);
}

// 守护进程启动时，把上次异常退出遗留的 running 任务标记为失败
export function failStaleRunningTasks(isAlive: (pid: number | null) => boolean): number {
  const rows = db().prepare("SELECT * FROM agent_tasks WHERE status = 'running'").all() as any[];
  let n = 0;
  for (const r of rows.map(rowToTask)) {
    if (!isAlive(r.pid)) {
      db()
        .prepare(
          "UPDATE agent_tasks SET status = 'failed', error = '执行进程中断（runner 重启）', finished_at = datetime('now','localtime') WHERE id = ?"
        )
        .run(r.id);
      n++;
    }
  }
  return n;
}

/* ---------- 需求附件 ---------- */

export interface AttachmentRow {
  id: number;
  requirementId: number;
  filename: string;
  storedPath: string;
  mime: string;
  size: number;
  uploadedBy: string;
  createdAt: string;
}

function rowToAttachment(r: any): AttachmentRow {
  return {
    id: r.id,
    requirementId: r.requirement_id,
    filename: r.filename,
    storedPath: r.stored_path,
    mime: r.mime,
    size: r.size,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
  };
}

export function addAttachment(input: {
  requirementId: number;
  filename: string;
  storedPath: string;
  mime: string;
  size: number;
  uploadedBy: string;
}): AttachmentRow {
  const res = db()
    .prepare(
      "INSERT INTO attachments (requirement_id, filename, stored_path, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(input.requirementId, input.filename, input.storedPath, input.mime, input.size, input.uploadedBy);
  return getAttachment(Number(res.lastInsertRowid))!;
}

export function getAttachment(id: number): AttachmentRow | null {
  const r = db().prepare("SELECT * FROM attachments WHERE id = ?").get(id);
  return r ? rowToAttachment(r) : null;
}

export function listAttachments(requirementId: number): AttachmentRow[] {
  const rows = db()
    .prepare("SELECT * FROM attachments WHERE requirement_id = ? ORDER BY id")
    .all(requirementId) as any[];
  return rows.map(rowToAttachment);
}

export function deleteAttachment(id: number) {
  db().prepare("DELETE FROM attachments WHERE id = ?").run(id);
}

/* ---------- runner 心跳与自愈 ---------- */

const RUNNER_STALE_MS = 20_000; // 心跳超过此值判定执行器离线

export function setMeta(key: string, value: string) {
  db()
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    .run(key, value, value);
}
export function getMeta(key: string): string | null {
  const r = db().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

// runner 每隔几秒调用：刷新全局心跳 + 给所有 running 任务打活性戳
export function runnerBeat(nowMs: number) {
  setMeta("runner_beat", String(nowMs));
  db().prepare("UPDATE agent_tasks SET beat_at = ? WHERE status = 'running'").run(String(nowMs));
}

export function runnerLastBeat(): number {
  return Number(getMeta("runner_beat") ?? 0);
}
export function runnerOnline(nowMs: number): boolean {
  return nowMs - runnerLastBeat() < RUNNER_STALE_MS;
}

// runner 启动自愈：把中途崩溃卡在 indexing 的仓库重新入队
export function resetStuckOnboarding(): number {
  const res = db()
    .prepare("UPDATE repos SET onboard_status = 'pending', onboard_step = '' WHERE onboard_status = 'indexing'")
    .run();
  return Number(res.changes ?? 0);
}

export function updateAgentTask(
  id: number,
  patch: Partial<
    Pick<AgentTaskRow, "status" | "step" | "error" | "pid" | "logPath" | "workspace" | "result">
  >
) {
  const colMap: Record<string, string> = {
    status: "status",
    step: "step",
    error: "error",
    pid: "pid",
    logPath: "log_path",
    workspace: "workspace",
    result: "result",
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${colMap[k]} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  if (patch.status === "succeeded" || patch.status === "failed") {
    sets.push("finished_at = datetime('now', 'localtime')");
  }
  db()
    .prepare(`UPDATE agent_tasks SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]), id);
}

export function listUsers(): User[] {
  const rows = db().prepare("SELECT * FROM users ORDER BY id").all() as any[];
  return rows.map(rowToUser);
}

export function getUserById(id: number): User | null {
  const r = db().prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
  return r ? rowToUser(r) : null;
}

export function getUserByProvider(provider: string, providerLogin: string): User | null {
  const r = db()
    .prepare("SELECT * FROM users WHERE provider = ? AND provider_login = ?")
    .get(provider, providerLogin) as any;
  return r ? rowToUser(r) : null;
}

export function addUser(input: {
  username: string;
  displayName: string;
  role: string;
  team: string;
  provider?: string;
  providerLogin?: string;
  password?: string; // 内置账号初始密码；OAuth 账号可不填
}): User {
  const provider = input.provider ?? "local";
  const passwordHash =
    provider === "local" ? hashPassword(input.password || DEFAULT_PASSWORD) : "";
  db()
    .prepare(
      "INSERT INTO users (username, display_name, role, team, provider, provider_login, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.username,
      input.displayName,
      input.role,
      input.team,
      provider,
      input.providerLogin ?? "",
      passwordHash
    );
  return getUser(input.username)!;
}

// 账密校验：仅内置账号；成功返回用户，失败返回 null
export function verifyLogin(username: string, password: string): User | null {
  const r = db().prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
  if (!r || (r.provider ?? "local") !== "local") return null;
  if (!verifyPassword(password, r.password_hash ?? "")) return null;
  return rowToUser(r);
}

export function setUserPassword(id: number, password: string) {
  db()
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(hashPassword(password), id);
}

export function updateUser(
  id: number,
  patch: { displayName?: string; role?: string; team?: string }
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.displayName !== undefined) {
    sets.push("display_name = ?");
    vals.push(patch.displayName);
  }
  if (patch.role !== undefined) {
    sets.push("role = ?");
    vals.push(patch.role);
  }
  if (patch.team !== undefined) {
    sets.push("team = ?");
    vals.push(patch.team);
  }
  if (!sets.length) return;
  db()
    .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]), id);
}

export function deleteUser(id: number) {
  db().prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function countAdmins(): number {
  const r = db().prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get() as {
    c: number;
  };
  return r.c;
}

export function getUser(username: string): User | null {
  const r = db().prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
  return r ? rowToUser(r) : null;
}
