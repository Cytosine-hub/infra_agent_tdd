import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  addRepoModule,
  confirmRepoModules,
  deleteRepoModule,
  getRepoById,
  getRepoModule,
  listRepoModules,
  repoModuleMapConfirmed,
  repoModuleMapStatus,
  updateRepoModule,
} from "@/lib/db";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { isRepoRelativeGlob, normalizeRepoPaths } from "@/lib/module-map";
import type { User } from "@/lib/types";

const PathsSchema = z
  .array(z.string().min(1).max(300))
  .min(1, "至少填写一个路径")
  .max(100)
  .refine((paths) => paths.every(isRepoRelativeGlob), "路径必须是仓库相对 glob，不能包含绝对路径或 ..");

const AddRepoModuleSchema = z.object({
  moduleKey: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "module key 仅支持小写字母、数字、-、_"),
  name: z.string().min(1, "模块名称不能为空").max(100),
  paths: PathsSchema,
  description: z.string().max(1000).default(""),
});

const EditRepoModuleSchema = z.object({
  moduleId: z.number().int().positive(),
  name: z.string().min(1, "模块名称不能为空").max(100),
  paths: PathsSchema,
  description: z.string().max(1000).default(""),
});

const ConfirmSchema = z.object({ action: z.literal("confirm") });

function canManageRepoModules(user: User): boolean {
  return user.role === "lead" || user.role === "admin";
}

function payload(repoId: number) {
  return {
    modules: listRepoModules(repoId),
    confirmed: repoModuleMapConfirmed(repoId),
    mapStatus: repoModuleMapStatus(repoId),
  };
}

export const GET = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    if (!canManageRepoModules(user)) return forbidden("仅组长或管理员可查看模块地图");
    const repoId = Number((await ctx.params).id);
    if (!getRepoById(repoId)) return badRequest("仓库不存在");
    return NextResponse.json(payload(repoId));
  }
);

export const POST = apiHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    if (!canManageRepoModules(user)) return forbidden("仅组长或管理员可维护模块地图");
    const repoId = Number((await ctx.params).id);
    if (!getRepoById(repoId)) return badRequest("仓库不存在");
    const parsed = AddRepoModuleSchema.safeParse(await req.json());
    if (!parsed.success) return badRequest(parsed.error.issues.map((issue) => issue.message).join("；"));
    if (listRepoModules(repoId).some((module) => module.moduleKey === parsed.data.moduleKey)) {
      return badRequest("同一仓库内 module key 不能重复");
    }
    addRepoModule({
      repoId,
      ...parsed.data,
      paths: normalizeRepoPaths(parsed.data.paths),
    });
    return NextResponse.json(payload(repoId), { status: 201 });
  }
);

export const PATCH = apiHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    if (!canManageRepoModules(user)) return forbidden("仅组长或管理员可维护模块地图");
    const repoId = Number((await ctx.params).id);
    if (!getRepoById(repoId)) return badRequest("仓库不存在");
    const body = await req.json();
    const confirm = ConfirmSchema.safeParse(body);
    if (confirm.success) {
      if (listRepoModules(repoId).length === 0) return badRequest("模块地图为空，不能确认");
      confirmRepoModules(repoId);
      return NextResponse.json(payload(repoId));
    }
    const parsed = EditRepoModuleSchema.safeParse(body);
    if (!parsed.success) return badRequest(parsed.error.issues.map((issue) => issue.message).join("；"));
    const repoModule = getRepoModule(parsed.data.moduleId);
    if (!repoModule || repoModule.repoId !== repoId) return badRequest("模块不存在");
    updateRepoModule(repoModule.id, {
      name: parsed.data.name,
      paths: normalizeRepoPaths(parsed.data.paths),
      description: parsed.data.description,
    });
    return NextResponse.json(payload(repoId));
  }
);

export const DELETE = apiHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    if (!canManageRepoModules(user)) return forbidden("仅组长或管理员可维护模块地图");
    const repoId = Number((await ctx.params).id);
    if (!getRepoById(repoId)) return badRequest("仓库不存在");
    const moduleId = Number(new URL(req.url).searchParams.get("moduleId"));
    const repoModule = getRepoModule(moduleId);
    if (!repoModule || repoModule.repoId !== repoId) return badRequest("模块不存在");
    deleteRepoModule(moduleId);
    return NextResponse.json(payload(repoId));
  }
);
