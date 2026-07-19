import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import type { Repo, Requirement, RequirementEvent, TestCase, User } from "./types";

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
      team TEXT NOT NULL DEFAULT ''
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
      indexed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'develop',
      engine TEXT NOT NULL DEFAULT 'claude',
      model TEXT NOT NULL DEFAULT '',
      effort TEXT NOT NULL DEFAULT '',
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
  const tcols = d.prepare("PRAGMA table_info(agent_tasks)").all() as { name: string }[];
  if (tcols.length > 0 && !tcols.some((c) => c.name === "model")) {
    d.exec("ALTER TABLE agent_tasks ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    d.exec("ALTER TABLE agent_tasks ADD COLUMN effort TEXT NOT NULL DEFAULT ''");
  }
  if (tcols.length > 0 && !tcols.some((c) => c.name === "kind")) {
    d.exec("ALTER TABLE agent_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'develop'");
    d.exec("ALTER TABLE agent_tasks ADD COLUMN result TEXT");
  }
  const rcols = d.prepare("PRAGMA table_info(requirements)").all() as { name: string }[];
  if (!rcols.some((c) => c.name === "exec_plan")) {
    d.exec("ALTER TABLE requirements ADD COLUMN exec_plan TEXT");
  }
  if (!rcols.some((c) => c.name === "guard_status")) {
    d.exec("ALTER TABLE requirements ADD COLUMN guard_status TEXT NOT NULL DEFAULT ''");
    d.exec("ALTER TABLE requirements ADD COLUMN guard_reason TEXT NOT NULL DEFAULT ''");
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
    "INSERT INTO users (username, display_name, role, team) VALUES (?, ?, ?, ?)"
  );
  ins.run("admin", "平台管理员", "admin", "平台");
  ins.run("db_lead", "数据库组组长", "lead", "数据库组");
  ins.run("db_member", "数据库组组员", "member", "数据库组");
  ins.run("mw_lead", "中间件组组长", "lead", "中间件组");
  ins.run("mw_member", "中间件组组员", "member", "中间件组");
  ins.run("host_lead", "主机组组长", "lead", "主机组");
  ins.run("net_lead", "网络组组长", "lead", "网络组");
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
  };
}

export function listRepos(): Repo[] {
  const rows = db().prepare("SELECT * FROM repos ORDER BY full_name").all() as any[];
  return rows.map(rowToRepo);
}

export function getRepoByName(fullName: string): Repo | null {
  const r = db().prepare("SELECT * FROM repos WHERE full_name = ?").get(fullName) as any;
  return r ? rowToRepo(r) : null;
}

export function addRepo(fullName: string, description = "", team = ""): Repo {
  // 新加仓库置 pending，由 runner 后台入驻（clone + codegraph 索引 + agent.md）
  db()
    .prepare(
      "INSERT OR IGNORE INTO repos (full_name, description, team, onboard_status) VALUES (?, ?, ?, 'pending')"
    )
    .run(fullName, description, team);
  return getRepoByName(fullName)!;
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

export type AgentTaskKind = "develop" | "review" | "testcases";

export interface AgentTaskRow {
  id: number;
  requirementId: number;
  kind: AgentTaskKind;
  engine: string;
  model: string;
  effort: string;
  result: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  step: string;
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
    result: r.result,
    status: r.status,
    step: r.step,
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
  kind: AgentTaskKind = "develop"
): AgentTaskRow {
  const res = db()
    .prepare(
      "INSERT INTO agent_tasks (requirement_id, engine, model, effort, kind) VALUES (?, ?, ?, ?, ?)"
    )
    .run(requirementId, engine, model, effort, kind);
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
}): User {
  db()
    .prepare(
      "INSERT INTO users (username, display_name, role, team, provider, provider_login) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.username,
      input.displayName,
      input.role,
      input.team,
      input.provider ?? "local",
      input.providerLogin ?? ""
    );
  return getUser(input.username)!;
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
