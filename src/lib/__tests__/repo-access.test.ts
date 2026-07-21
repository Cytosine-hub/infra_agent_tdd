import { describe, expect, it } from "vitest";
import { canUseRepo, selectableRepos } from "../repo-access";
import type { Repo, User } from "../types";

const repoDefaults: Omit<Repo, "id" | "fullName" | "team"> = {
  description: "",
  onboardStatus: "ready",
  onboardStep: "",
  onboardError: "",
  onboardPr: "",
  indexedAt: null,
  hasToken: false,
  host: "github.com",
  provider: "github",
};
const publicRepo: Repo = { ...repoDefaults, id: 1, fullName: "org/public", team: "" };
const dbRepo: Repo = { ...repoDefaults, id: 2, fullName: "org/db-tools", team: "数据库组" };

const dbMember: User = {
  id: 1, username: "db_member", displayName: "", role: "member", team: "数据库组",
  provider: "local", providerLogin: "",
};
const netMember: User = { ...dbMember, id: 2, username: "net_member", team: "网络组" };
const admin: User = { ...dbMember, id: 3, username: "admin", role: "admin", team: "平台" };

describe("canUseRepo", () => {
  it("公共仓库人人可用", () => {
    expect(canUseRepo(publicRepo, netMember)).toBeNull();
  });

  it("组属仓库仅本组成员可用", () => {
    expect(canUseRepo(dbRepo, dbMember)).toBeNull();
    expect(canUseRepo(dbRepo, netMember)).toContain("数据库组");
  });

  it("管理员可用任何仓库", () => {
    expect(canUseRepo(dbRepo, admin)).toBeNull();
  });
});

describe("selectableRepos", () => {
  it("按用户过滤可选仓库", () => {
    expect(selectableRepos([publicRepo, dbRepo], netMember).map((r) => r.fullName)).toEqual([
      "org/public",
    ]);
    expect(selectableRepos([publicRepo, dbRepo], dbMember)).toHaveLength(2);
  });
});
