import { describe, expect, it } from "vitest";
import { canChangeRole, canDeleteUser, canManageUsers } from "../user-admin";
import type { User } from "../types";

const admin: User = { id: 1, username: "admin", displayName: "", role: "admin", team: "平台" };
const admin2: User = { id: 9, username: "admin2", displayName: "", role: "admin", team: "平台" };
const lead: User = { id: 2, username: "db_lead", displayName: "", role: "lead", team: "数据库组" };
const member: User = { id: 3, username: "db_member", displayName: "", role: "member", team: "数据库组" };

describe("canManageUsers", () => {
  it("仅管理员可管理账号", () => {
    expect(canManageUsers(admin)).toBeNull();
    expect(canManageUsers(lead)).not.toBeNull();
    expect(canManageUsers(member)).not.toBeNull();
  });
});

describe("canDeleteUser", () => {
  it("不能删除自己", () => {
    expect(canDeleteUser(admin, admin, 2)).not.toBeNull();
  });

  it("不能删除最后一个管理员", () => {
    expect(canDeleteUser(admin2, admin, 1)).not.toBeNull();
    expect(canDeleteUser(admin2, admin, 2)).toBeNull();
  });

  it("管理员可删除普通账号", () => {
    expect(canDeleteUser(admin, member, 1)).toBeNull();
  });
});

describe("canChangeRole", () => {
  it("不能降级最后一个管理员", () => {
    expect(canChangeRole(admin, admin, "member", 1)).not.toBeNull();
    expect(canChangeRole(admin, admin, "admin", 1)).toBeNull();
    expect(canChangeRole(admin, admin2, "member", 2)).toBeNull();
  });

  it("管理员可正常调整他人角色", () => {
    expect(canChangeRole(admin, member, "lead", 1)).toBeNull();
  });
});
