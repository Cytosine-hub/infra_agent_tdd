import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { RepoModule, Requirement, User } from "../types";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  addRepoModule: vi.fn(),
  confirmRepoModules: vi.fn(),
  deleteRepoModule: vi.fn(),
  getRepoById: vi.fn(),
  getRepoModule: vi.fn(),
  listRepoModules: vi.fn(),
  repoModuleMapConfirmed: vi.fn(),
  updateRepoModule: vi.fn(),
  addEvent: vi.fn(),
  getRepoByName: vi.fn(),
  getRequirement: vi.fn(),
  lockRequirementScope: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireUser: mocks.requireUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/db", () => ({
  addRepoModule: mocks.addRepoModule,
  confirmRepoModules: mocks.confirmRepoModules,
  deleteRepoModule: mocks.deleteRepoModule,
  getRepoById: mocks.getRepoById,
  getRepoModule: mocks.getRepoModule,
  listRepoModules: mocks.listRepoModules,
  repoModuleMapConfirmed: mocks.repoModuleMapConfirmed,
  updateRepoModule: mocks.updateRepoModule,
  addEvent: mocks.addEvent,
  getRepoByName: mocks.getRepoByName,
  getRequirement: mocks.getRequirement,
  lockRequirementScope: mocks.lockRequirementScope,
}));

import {
  GET as listModules,
  PATCH as editModules,
  POST as addModule,
} from "@/app/api/repos/[id]/modules/route";
import { PATCH as lockScope } from "@/app/api/requirements/[id]/scope/route";

const auth = { provider: "local" as const, providerLogin: "" };
const member: User = {
  ...auth,
  id: 1,
  username: "member",
  displayName: "",
  role: "member",
  team: "数据库组",
};
const lead: User = { ...member, id: 2, username: "lead", role: "lead" };
const repoModule: RepoModule = {
  id: 3,
  repoId: 1,
  moduleKey: "admin-web",
  name: "管理端",
  paths: ["apps/admin/**"],
  description: "",
  confirmed: 1,
  sortOrder: 0,
};
const requirement = {
  id: 9,
  team: "数据库组",
  repo: "org/portal",
  status: "submitted",
} as Requirement;
const moduleContext = { params: Promise.resolve({ id: "1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRepoById.mockReturnValue({ id: 1 });
  mocks.getRepoByName.mockReturnValue({ id: 1 });
  mocks.listRepoModules.mockReturnValue([repoModule]);
  mocks.repoModuleMapConfirmed.mockReturnValue(true);
  mocks.getRequirement.mockReturnValue(requirement);
});

describe("模块地图 API", () => {
  it("拒绝组员读取管理接口", async () => {
    mocks.requireUser.mockResolvedValue(member);
    const response = await listModules(
      new NextRequest("http://localhost/api/repos/1/modules"),
      moduleContext
    );
    expect(response.status).toBe(403);
  });

  it("拒绝组员写入", async () => {
    mocks.requireUser.mockResolvedValue(member);
    const response = await addModule(
      new NextRequest("http://localhost/api/repos/1/modules", {
        method: "POST",
        body: JSON.stringify({
          moduleKey: "new-module",
          name: "新模块",
          paths: ["src/new/**"],
          description: "",
        }),
      }),
      moduleContext
    );
    expect(response.status).toBe(403);
    expect(mocks.addRepoModule).not.toHaveBeenCalled();
  });

  it("组长可添加合法模块，非法越级路径被拒绝", async () => {
    mocks.requireUser.mockResolvedValue(lead);
    mocks.listRepoModules.mockReturnValue([]);
    const ok = await addModule(
      new NextRequest("http://localhost/api/repos/1/modules", {
        method: "POST",
        body: JSON.stringify({
          moduleKey: "new-module",
          name: "新模块",
          paths: ["src/new/**"],
          description: "新增功能",
        }),
      }),
      moduleContext
    );
    expect(ok.status).toBe(201);
    expect(mocks.addRepoModule).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 1, moduleKey: "new-module", paths: ["src/new/**"] })
    );

    const invalid = await addModule(
      new NextRequest("http://localhost/api/repos/1/modules", {
        method: "POST",
        body: JSON.stringify({ moduleKey: "bad", name: "坏模块", paths: ["../outside/**"] }),
      }),
      moduleContext
    );
    expect(invalid.status).toBe(400);
  });

  it("空地图不能确认", async () => {
    mocks.requireUser.mockResolvedValue(lead);
    mocks.listRepoModules.mockReturnValue([]);
    const response = await editModules(
      new NextRequest("http://localhost/api/repos/1/modules", {
        method: "PATCH",
        body: JSON.stringify({ action: "confirm" }),
      }),
      moduleContext
    );
    expect(response.status).toBe(400);
    expect(mocks.confirmRepoModules).not.toHaveBeenCalled();
  });
});

describe("需求范围锁定 API", () => {
  it("仅本组组长可锁定，并允许显式加入额外相对路径", async () => {
    mocks.requireUser.mockResolvedValue(member);
    const denied = await lockScope(
      new NextRequest("http://localhost/api/requirements/9/scope", {
        method: "PATCH",
        body: JSON.stringify({ moduleKeys: ["admin-web"], scopePaths: ["apps/admin/**"] }),
      }),
      { params: Promise.resolve({ id: "9" }) }
    );
    expect(denied.status).toBe(403);

    mocks.requireUser.mockResolvedValue(lead);
    const accepted = await lockScope(
      new NextRequest("http://localhost/api/requirements/9/scope", {
        method: "PATCH",
        body: JSON.stringify({
          moduleKeys: ["admin-web"],
          scopePaths: ["apps/admin/**", "packages/shared/audit/**"],
        }),
      }),
      { params: Promise.resolve({ id: "9" }) }
    );
    expect(accepted.status).toBe(200);
    expect(mocks.lockRequirementScope).toHaveBeenCalledWith(
      9,
      ["admin-web"],
      ["apps/admin/**", "packages/shared/audit/**"],
      "lead"
    );
  });
});
