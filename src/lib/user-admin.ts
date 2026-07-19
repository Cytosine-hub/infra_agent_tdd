import type { Role, User } from "./types";

// 账号管理的权限与安全规则（纯函数，便于测试）：
// - 仅管理员可增删改账号
// - 不能删除自己
// - 不能删除/降级最后一个管理员，避免系统失去管理入口
export function canManageUsers(actor: User): string | null {
  return actor.role === "admin" ? null : "仅管理员可管理账号";
}

export function canDeleteUser(actor: User, target: User, adminCount: number): string | null {
  const denied = canManageUsers(actor);
  if (denied) return denied;
  if (actor.id === target.id) return "不能删除当前登录的账号";
  if (target.role === "admin" && adminCount <= 1) return "至少保留一个管理员账号";
  return null;
}

export function canChangeRole(
  actor: User,
  target: User,
  newRole: Role,
  adminCount: number
): string | null {
  const denied = canManageUsers(actor);
  if (denied) return denied;
  if (target.role === "admin" && newRole !== "admin" && adminCount <= 1) {
    return "至少保留一个管理员账号";
  }
  return null;
}
