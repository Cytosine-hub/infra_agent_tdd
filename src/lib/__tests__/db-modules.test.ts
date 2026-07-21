import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-db-modules-"));
const previousDataDir = process.env.DATA_DIR;
const legacy = new DatabaseSync(path.join(testDataDir, "portal.db"));
legacy.exec(`
  CREATE TABLE requirements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    team TEXT NOT NULL,
    repo TEXT NOT NULL DEFAULT '',
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
    exec_plan TEXT,
    guard_status TEXT NOT NULL DEFAULT '',
    guard_reason TEXT NOT NULL DEFAULT '',
    review_verdict TEXT NOT NULL DEFAULT '',
    review_feedback TEXT NOT NULL DEFAULT '',
    fix_rounds INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  INSERT INTO requirements (title, team, repo, description, created_by)
  VALUES ('旧需求', '数据库组', 'org/legacy', '迁移时必须保留', 'member');
`);
legacy.close();
process.env.DATA_DIR = testDataDir;

let store: typeof import("../db");

beforeAll(async () => {
  store = await import("../db");
  store.db();
});

afterAll(() => {
  store.db().close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
});

describe("模块地图数据库迁移与助手", () => {
  it("旧库幂等补齐新列和表且不丢数据", () => {
    const columns = store.db().prepare("PRAGMA table_info(requirements)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "module_key",
        "scope_paths",
        "module_suggestion",
        "scope_locked_by",
        "scope_locked_at",
      ])
    );
    expect(
      store.db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repo_modules'").get()
    ).toBeTruthy();
    expect(store.getRequirement(1)?.title).toBe("旧需求");
    expect(store.getRequirement(1)?.scopePaths).toEqual([]);

    store.db().close();
    vi.resetModules();
    return import("../db").then((reloaded) => {
      store = reloaded;
      expect(store.getRequirement(1)?.title).toBe("旧需求");
      expect(store.getRequirement(1)?.moduleSuggestion).toBeNull();
    });
  });

  it("支持模块地图增删改、整图确认和编辑后失效", () => {
    const repo = store.addRepo("org/modules");
    const admin = store.addRepoModule({
      repoId: repo.id,
      moduleKey: "admin-web",
      name: "管理端",
      paths: ["apps/admin/**"],
      description: "后台页面",
    });
    store.addRepoModule({
      repoId: repo.id,
      moduleKey: "shared",
      name: "公共",
      paths: ["packages/shared/**"],
    });
    expect(store.listRepoModules(repo.id)).toHaveLength(2);
    expect(store.repoModuleMapConfirmed(repo.id)).toBe(false);
    expect(store.confirmRepoModules(repo.id)).toBe(2);
    expect(store.repoModuleMapConfirmed(repo.id)).toBe(true);

    store.updateRepoModule(admin.id, { paths: ["apps/admin/**", "packages/admin-api/**"] });
    expect(store.repoModuleMapConfirmed(repo.id)).toBe(false);
    expect(store.getRepoModule(admin.id)?.paths).toContain("packages/admin-api/**");
    expect(store.deleteRepoModule(admin.id)).toBe(true);
    expect(store.listRepoModules(repo.id).map((module) => module.moduleKey)).toEqual(["shared"]);
  });

  it("写入并读取 AI 建议与人工锁定范围", () => {
    const requirement = store.createRequirement({
      title: "模块范围需求",
      team: "数据库组",
      repo: "org/modules",
      priority: "P1",
      description: "这是一个用于验证模块范围字段写入读取的需求。",
      testScenarios: "只改管理端",
      createdBy: "member",
    });
    store.updateRequirementModuleSuggestion(requirement.id, {
      moduleKey: "shared",
      rationale: "涉及共享协议",
      confidence: 0.8,
      scopePaths: ["packages/shared/**"],
    });
    store.lockRequirementScope(
      requirement.id,
      ["shared", "admin-web"],
      ["packages/shared/**", "apps/admin/**"],
      "lead"
    );
    const updated = store.getRequirement(requirement.id)!;
    expect(updated.moduleSuggestion?.confidence).toBe(0.8);
    expect(updated.moduleKey).toBe("shared,admin-web");
    expect(updated.scopePaths).toEqual(["packages/shared/**", "apps/admin/**"]);
    expect(updated.scopeLockedBy).toBe("lead");
    expect(updated.scopeLockedAt).toBeTruthy();
  });
});
