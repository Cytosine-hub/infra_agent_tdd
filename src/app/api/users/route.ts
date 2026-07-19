import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  addUser,
  countAdmins,
  deleteUser,
  getUser,
  getUserById,
  listUsers,
  teamExists,
  updateUser,
} from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { canChangeRole, canDeleteUser, canManageUsers } from "@/lib/user-admin";
import type { Role } from "@/lib/types";

export const GET = apiHandler(async () => {
  await requireUser();
  return NextResponse.json({ users: listUsers() });
});

const AddSchema = z.object({
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{2,32}$/, "用户名为 2-32 位字母/数字/下划线"),
  displayName: z.string().min(1, "显示名不能为空").max(32),
  role: z.enum(["member", "lead", "admin"]),
  team: z.string().min(1, "必须填写小组"),
});

export const POST = apiHandler(async (req: NextRequest) => {
  const actor = await requireUser();
  const denied = canManageUsers(actor);
  if (denied) return forbidden(denied);
  const parsed = AddSchema.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join("；"));
  if (getUser(parsed.data.username)) return badRequest("用户名已存在");
  if (!teamExists(parsed.data.team) && parsed.data.team !== "未分配") {
    return badRequest("小组不存在，请先在「小组管理」中添加");
  }
  const user = addUser(parsed.data);
  return NextResponse.json({ user }, { status: 201 });
});

const PatchSchema = z.object({
  id: z.number(),
  displayName: z.string().min(1).max(32).optional(),
  role: z.enum(["member", "lead", "admin"]).optional(),
  team: z.string().min(1).optional(),
});

export const PATCH = apiHandler(async (req: NextRequest) => {
  const actor = await requireUser();
  const parsed = PatchSchema.safeParse(await req.json());
  if (!parsed.success) return badRequest("请求参数错误");
  const target = getUserById(parsed.data.id);
  if (!target) return badRequest("用户不存在");
  if (
    parsed.data.team !== undefined &&
    !teamExists(parsed.data.team) &&
    parsed.data.team !== "未分配"
  ) {
    return badRequest("小组不存在，请先在「小组管理」中添加");
  }
  const denied =
    parsed.data.role !== undefined
      ? canChangeRole(actor, target, parsed.data.role as Role, countAdmins())
      : canManageUsers(actor);
  if (denied) return forbidden(denied);
  updateUser(parsed.data.id, parsed.data);
  return NextResponse.json({ user: getUserById(parsed.data.id) });
});

export const DELETE = apiHandler(async (req: NextRequest) => {
  const actor = await requireUser();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!id) return badRequest("缺少 id");
  const target = getUserById(id);
  if (!target) return badRequest("用户不存在");
  const denied = canDeleteUser(actor, target, countAdmins());
  if (denied) return forbidden(denied);
  deleteUser(id);
  return NextResponse.json({ ok: true });
});
