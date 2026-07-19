import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const execFileP = promisify(execFile);

export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

// 服务器按仓库存一份持久 clone + codegraph 索引，供各任务复用
export function repoMirrorDir(repoFullName: string): string {
  return path.join(DATA_DIR, "repos", repoFullName.replace(/[/]/g, "__"));
}

export function cloneUrl(repoFullName: string): string {
  const token = process.env.GITHUB_TOKEN;
  return token
    ? `https://x-access-token:${token}@github.com/${repoFullName}.git`
    : `git@github.com:${repoFullName}.git`;
}

export async function codegraphAvailable(): Promise<boolean> {
  try {
    await execFileP("which", ["codegraph"]);
    return true;
  } catch {
    return false;
  }
}

const CG_TIMEOUT = 300_000;

async function cg(args: string[], cwd: string) {
  await execFileP("codegraph", args, { cwd, timeout: CG_TIMEOUT, maxBuffer: 50 * 1024 * 1024 });
}

// 入驻时建/刷新持久镜像索引。返回索引节点信息文本（供日志）。
export async function buildMirrorIndex(repoFullName: string): Promise<void> {
  const mirror = repoMirrorDir(repoFullName);
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  if (fs.existsSync(path.join(mirror, ".git"))) {
    await execFileP("git", ["-C", mirror, "fetch", "--depth", "20", "origin"], { timeout: CG_TIMEOUT });
    await execFileP("git", ["-C", mirror, "reset", "--hard", "origin/HEAD"], { timeout: CG_TIMEOUT }).catch(
      async () => {
        // origin/HEAD 未设置时按默认分支
        await execFileP("git", ["-C", mirror, "pull", "--ff-only"], { timeout: CG_TIMEOUT });
      }
    );
  } else {
    fs.rmSync(mirror, { recursive: true, force: true });
    await execFileP("git", ["clone", "--depth", "20", cloneUrl(repoFullName), mirror], {
      timeout: CG_TIMEOUT,
    });
  }
  if (!(await codegraphAvailable())) return;
  if (fs.existsSync(path.join(mirror, ".codegraph"))) await cg(["sync", "."], mirror);
  else await cg(["init", "."], mirror);
}

// 任务工作区准备索引：优先复用镜像索引（拷贝 + sync，快），无镜像则 fresh init。
// 返回是否建成可用索引。
export async function prepareWorkspaceIndex(workspace: string, repoFullName: string): Promise<boolean> {
  if (!(await codegraphAvailable())) return false;
  // .codegraph/ 是本地索引，绝不能进 PR
  try {
    fs.appendFileSync(path.join(workspace, ".git", "info", "exclude"), "\n.codegraph/\n");
  } catch {
    /* ignore */
  }
  try {
    const mirrorIdx = path.join(repoMirrorDir(repoFullName), ".codegraph");
    if (fs.existsSync(mirrorIdx)) {
      fs.cpSync(mirrorIdx, path.join(workspace, ".codegraph"), { recursive: true });
      await cg(["sync", "."], workspace); // 增量同步到本分支，远快于全量
    } else {
      await cg(["init", "."], workspace); // 无镜像（如入驻前）则全量建
    }
    return true;
  } catch (err) {
    console.error("codegraph 工作区索引失败（跳过，不影响任务）:", err);
    return false;
  }
}
