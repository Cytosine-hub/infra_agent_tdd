import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { getRepoHost, getRepoToken } from "./db";

const execFileP = promisify(execFile);

export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const GIT_TIMEOUT = 600_000;
const CG_TIMEOUT = 300_000;

// 每个项目一个共享工作区（runner 全局串行，故同项目任务串行复用同一目录；后期并行再改）。
export function repoWorkspaceDir(repoFullName: string): string {
  return path.join(DATA_DIR, "repos", repoFullName.replace(/[/]/g, "__"));
}
// 兼容旧名
export const repoMirrorDir = repoWorkspaceDir;

// 带认证的 clone/push URL：优先用仓库绑定的专用 token（一仓一 token），否则回退全局 GITHUB_TOKEN。
// 支持不同主机（github.com / 自建 GitLab）；GitLab 用 oauth2 用户名，GitHub 用 x-access-token。
// host 可携带协议前缀（如 http://gitlab.internal），用于 HTTP-only 的自建 GitLab；缺省按 https。
export function cloneUrl(repoFullName: string): string {
  const repoToken = getRepoToken(repoFullName);
  const raw = getRepoHost(repoFullName);
  const scheme = raw.match(/^(https?):\/\//)?.[1] ?? "https";
  const host = raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const token = repoToken || (host === "github.com" ? process.env.GITHUB_TOKEN : "");
  if (!token) return `git@${host}:${repoFullName}.git`;
  const user = host === "github.com" ? "x-access-token" : "oauth2";
  return `${scheme}://${user}:${token}@${host}/${repoFullName}.git`;
}

// 主机无关地探测远程默认分支（GitHub/GitLab 通用）：读取远程 HEAD 的 symref。
// 拿不到时回退 main。用于入驻/切基线分支，避免写死 main 而在 master 仓库失败。
export async function remoteDefaultBranch(repoFullName: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["ls-remote", "--symref", cloneUrl(repoFullName), "HEAD"], {
      timeout: 60_000,
    });
    const m = stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    return m?.[1] ?? "main";
  } catch {
    return "main";
  }
}

export async function codegraphAvailable(): Promise<boolean> {
  try {
    await execFileP("which", ["codegraph"]);
    return true;
  } catch {
    return false;
  }
}

async function git(dir: string, args: string[]) {
  await execFileP("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT, maxBuffer: 50 * 1024 * 1024 });
}
async function cg(args: string[], cwd: string) {
  await execFileP("codegraph", args, { cwd, timeout: CG_TIMEOUT, maxBuffer: 50 * 1024 * 1024 });
}

export interface PrepareOpts {
  branch?: string; // 目标功能分支
  base?: string; // 默认分支（新开发时功能分支从它切出）
  useExistingBranch?: boolean; // true=复用远程既有分支（修复/审查），false=从 base 新建
}

// 准备共享工作区：确保已 clone（全量，含所有分支）→ 清理上一个任务残留 → 切到目标分支 → 增量建索引。
// 返回工作区路径与索引是否可用。全局串行调用，无并发。
export async function prepareRepoWorkspace(
  repoFullName: string,
  opts: PrepareOpts
): Promise<{ dir: string; indexed: boolean }> {
  const dir = repoWorkspaceDir(repoFullName);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    // 全量 clone（含所有分支），后续任务只 fetch；origin/<分支> ref 齐全，避免浅克隆的 checkout 问题
    await execFileP("git", ["clone", cloneUrl(repoFullName), dir], { timeout: GIT_TIMEOUT });
    fs.appendFileSync(path.join(dir, ".git", "info", "exclude"), "\n.codegraph/\nnode_modules/\n");
  }

  // 清理上一个任务的未提交改动与未跟踪文件（保留 .codegraph / node_modules 等被忽略项，加速下次）
  await git(dir, ["reset", "--hard"]);
  await git(dir, ["clean", "-fd"]);
  // 确保拉取所有分支的远程跟踪 ref（兼容遗留的单分支/浅克隆，否则 origin/<功能分支> 不存在）
  await git(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await git(dir, ["fetch", "origin", "--prune"]);

  if (opts.branch && opts.useExistingBranch) {
    await git(dir, ["checkout", "-B", opts.branch, `origin/${opts.branch}`]);
  } else if (opts.branch && opts.base) {
    await git(dir, ["checkout", "-B", opts.branch, `origin/${opts.base}`]);
  } else if (opts.base) {
    await git(dir, ["checkout", "-B", opts.base, `origin/${opts.base}`]);
  }

  let indexed = false;
  if (await codegraphAvailable()) {
    try {
      if (fs.existsSync(path.join(dir, ".codegraph"))) {
        // 增量同步；索引元数据无效（如"not initialized"）时回退全量重建
        await cg(["sync", "."], dir).catch(async () => {
          fs.rmSync(path.join(dir, ".codegraph"), { recursive: true, force: true });
          await cg(["init", "."], dir);
        });
      } else {
        await cg(["init", "."], dir);
      }
      indexed = true;
    } catch (err) {
      console.error("codegraph 索引失败（跳过，不影响任务）:", err);
    }
  }
  return { dir, indexed };
}
