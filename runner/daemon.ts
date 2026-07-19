// 本地 Agent 执行守护进程（与门户 Web 进程解耦，门户重启不中断任务）。
// 启动：npm run runner   （生产建议配 launchd/pm2 常驻）
// 职责：轮询 SQLite 中排队的任务（用例生成 / 开发 / PR 审查）并串行执行。
import path from "node:path";
import fs from "node:fs";

// 加载 .env.local / .env（与 Next.js 行为对齐，避免引入 dotenv 依赖）
for (const file of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

import { claimNextPendingRepo, claimNextQueuedTask, failStaleRunningTasks } from "../src/lib/db";
import { executeTask, pidAlive } from "../src/lib/agent-runner";
import { runRepoOnboard } from "../src/lib/onboard";

const POLL_MS = 3000;
let stopping = false;

async function main() {
  const stale = failStaleRunningTasks(pidAlive);
  if (stale > 0) console.log(`[runner] 启动恢复：${stale} 个中断任务已标记失败（可在门户重触发）`);
  console.log(`[runner] agent runner 已启动，轮询间隔 ${POLL_MS}ms`);

  while (!stopping) {
    // 优先处理仓库入驻（新加仓库须先建索引 + agent.md 才能开发）
    const repo = claimNextPendingRepo();
    if (repo) {
      console.log(`[runner] 入驻仓库 ${repo.fullName}（建索引 + agent.md）`);
      const t0 = Date.now();
      await runRepoOnboard(repo.id);
      console.log(`[runner] 仓库 ${repo.fullName} 入驻结束，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
      continue;
    }

    const task = claimNextQueuedTask();
    if (task) {
      console.log(
        `[runner] 认领任务 #${task.id} kind=${task.kind} engine=${task.engine}` +
          (task.model ? ` model=${task.model}` : "") +
          (task.effort ? ` effort=${task.effort}` : "")
      );
      const t0 = Date.now();
      await executeTask(task.id);
      console.log(`[runner] 任务 #${task.id} 结束，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
    } else {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

main().catch((err) => {
  console.error("[runner] 致命错误:", err);
  process.exit(1);
});
