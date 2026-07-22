import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, repoWorkspaceDir } from "./repo-index";
import { listRepos } from "./db";

// 门户运行期产生的可再生数据清理策略：
// 1) 孤儿工作区（仓库改名/移除后残留的 data/repos/* 克隆，可再 clone）
// 2) 过期任务日志（data/agent-logs/task-*.log，按保留天数删旧）
// 这些都是可再生内容，删除不影响正确性；由 runner 启动时 + 每天定时执行。

const LOG_DIR = path.join(DATA_DIR, "agent-logs");
const REPOS_DIR = path.join(DATA_DIR, "repos");
const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 14);

// 删除不再对应任何现有仓库的工作区目录。返回被删的目录名。
export function pruneOrphanWorkspaces(): string[] {
  if (!fs.existsSync(REPOS_DIR)) return [];
  const valid = new Set(listRepos().map((r) => path.basename(repoWorkspaceDir(r.fullName))));
  const removed: string[] = [];
  for (const name of fs.readdirSync(REPOS_DIR)) {
    if (valid.has(name)) continue;
    try {
      fs.rmSync(path.join(REPOS_DIR, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* 忽略：下次再试 */
    }
  }
  return removed;
}

// 删除超过保留期（默认 14 天，可用 LOG_RETENTION_DAYS 覆盖）的任务日志。返回删除数量。
export function pruneOldTaskLogs(maxAgeDays = LOG_RETENTION_DAYS): number {
  if (!fs.existsSync(LOG_DIR)) return 0;
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let n = 0;
  for (const f of fs.readdirSync(LOG_DIR)) {
    if (!f.endsWith(".log")) continue;
    const p = path.join(LOG_DIR, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { force: true });
        n++;
      }
    } catch {
      /* 忽略 */
    }
  }
  return n;
}

// 删除单个仓库的工作区（仓库从门户移除时调用，避免留孤儿）。
export function removeRepoWorkspace(fullName: string): void {
  try {
    fs.rmSync(repoWorkspaceDir(fullName), { recursive: true, force: true });
  } catch {
    /* 忽略：不存在或占用，交给孤儿清理兜底 */
  }
}

// runner 周期清理入口：孤儿工作区 + 过期日志。
export function runCleanup(): { orphans: string[]; logs: number } {
  return { orphans: pruneOrphanWorkspaces(), logs: pruneOldTaskLogs() };
}
