import Link from "next/link";
import { redirect } from "next/navigation";
import { listRequirements, listTeams } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { STATUS_LABELS, type Requirement, type Status } from "@/lib/types";
import StatusBadge from "@/components/StatusBadge";
import TeamFilter from "@/components/TeamFilter";

export const dynamic = "force-dynamic";

// 看板列：只展示正在推进的需求；被驳回/安全审查未通过的收进底部「已驳回」区
const LANES: { title: string; statuses: Status[] }[] = [
  { title: "需求审核", statuses: ["submitted"] },
  { title: "测试用例", statuses: ["requirement_approved", "testcases_generated"] },
  { title: "待开发", statuses: ["testcases_approved"] },
  { title: "开发 / 审查", statuses: ["developing", "in_review"] },
  { title: "已完成", statuses: ["done"] },
];

// 统计条只展示活跃流程状态（驳回/终止不计入）
const ACTIVE_STATUSES: Status[] = [
  "submitted",
  "requirement_approved",
  "testcases_generated",
  "testcases_approved",
  "developing",
  "in_review",
  "done",
];

// 已终止：被驳回（需求/用例）或安全审查未通过——退出主流程，收进折叠区
function isArchived(r: Requirement): boolean {
  return (
    r.guardStatus === "rejected" ||
    r.status === "requirement_rejected" ||
    r.status === "testcases_rejected"
  );
}

function archiveNote(r: Requirement): string {
  if (r.guardStatus === "rejected") return `🛡️ 安全审查未通过：${r.guardReason}`;
  if (r.status === "requirement_rejected") return `需求驳回：${r.rejectReason ?? "无原因"}`;
  if (r.status === "testcases_rejected") return `用例驳回：${r.rejectReason ?? "无原因"}`;
  return "";
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ mine?: string; team?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const all = listRequirements();
  const isAdmin = user.role === "admin";

  // 管理员：按下拉框选择的岗位筛选；其他角色：「只看本岗位」开关
  const mineOnly = !isAdmin && params.mine === "1";
  const teamFilter = isAdmin ? (params.team ?? "") : mineOnly ? user.team : "";
  const scoped = teamFilter ? all.filter((r) => r.team === teamFilter) : all;
  const requirements = scoped.filter((r) => !isArchived(r));
  const archived = scoped.filter(isArchived);
  const teams = [...new Set([...listTeams().map((t) => t.name), ...all.map((r) => r.team)])];
  const countBy = (s: Status) => requirements.filter((r) => r.status === s).length;

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">工作台</h1>
          <p className="mt-1 text-sm text-zinc-500">
            需求提交 → 组长审核 → AI 生成测试用例 → 双方审核 → Agent 开发 → PR 审查 → 合并部署
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isAdmin ? (
            <TeamFilter teams={teams} current={teamFilter} />
          ) : (
            <Link
              href={mineOnly ? "/" : "/?mine=1"}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
                mineOnly
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              <span
                className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${
                  mineOnly ? "bg-emerald-400" : "bg-zinc-300"
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${
                    mineOnly ? "translate-x-3.5" : "translate-x-0.5"
                  }`}
                />
              </span>
              只看本岗位（{user.team}）
            </Link>
          )}
          <Link href="/requirements/new" className="btn-primary">
            + 提交需求
          </Link>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-4 gap-3 sm:grid-cols-7">
        {ACTIVE_STATUSES.map((s) => (
          <div key={s} className="card px-3 py-2.5 text-center">
            <div className="text-lg font-semibold">{countBy(s)}</div>
            <div className="mt-0.5 text-xs text-zinc-500">{STATUS_LABELS[s]}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-3 lg:grid-cols-5">
        {LANES.map((lane) => {
          const all = requirements.filter((r) => lane.statuses.includes(r.status));
          // 已完成列只展示最近 8 条，避免页面被历史需求撑长
          const isDone = lane.title === "已完成";
          const items = isDone ? all.slice(0, 8) : all;
          return (
            <div
              key={lane.title}
              className="flex min-w-0 flex-col rounded-xl bg-zinc-100/70 p-2"
            >
              <div className="mb-2 flex items-center gap-2 px-1.5 pt-1 text-sm font-semibold text-zinc-700">
                {lane.title}
                <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-600">
                  {all.length}
                </span>
              </div>
              {/* 泳道内独立滚动，整页高度固定 */}
              <div className="flex max-h-[calc(100vh-330px)] min-h-24 flex-col gap-2 overflow-y-auto pr-0.5">
                {all.length === 0 && (
                  <div className="rounded-lg border border-dashed border-zinc-300 py-5 text-center text-xs text-zinc-400">
                    暂无需求
                  </div>
                )}
                {items.map((r) => (
                  <RequirementCard key={r.id} r={r} />
                ))}
                {isDone && all.length > items.length && (
                  <div className="py-1.5 text-center text-xs text-zinc-400">
                    仅显示最近 {items.length} 条，共 {all.length} 条
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {archived.length > 0 && (
        <details className="mt-6 rounded-xl border border-zinc-200 bg-white">
          <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold text-zinc-600 select-none">
            已驳回 / 已终止
            <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-600">
              {archived.length}
            </span>
            <span className="text-xs font-normal text-zinc-400">
              （被驳回或安全审查未通过，已退出主流程；点开查看）
            </span>
          </summary>
          <div className="grid gap-2 border-t border-zinc-100 p-3 sm:grid-cols-2 lg:grid-cols-3">
            {archived.map((r) => (
              <RequirementCard key={r.id} r={r} note={archiveNote(r)} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function RequirementCard({ r, note }: { r: Requirement; note?: string }) {
  return (
    <Link
      href={`/requirements/${r.id}`}
      className={`card block p-2.5 transition hover:border-zinc-400 hover:shadow ${
        note ? "opacity-75 hover:opacity-100" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-zinc-400">
          #{r.id}
          {r.prNumber && <span className="ml-1.5 text-sky-600">PR#{r.prNumber}</span>}
        </span>
        <StatusBadge status={r.status} />
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{r.title}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-zinc-500">
        <span className="rounded bg-zinc-100 px-1.5 py-0.5">{r.team}</span>
        <span
          className={`rounded px-1.5 py-0.5 ${
            r.priority === "P0"
              ? "bg-red-100 text-red-700"
              : r.priority === "P1"
                ? "bg-amber-100 text-amber-700"
                : "bg-zinc-100"
          }`}
        >
          {r.priority}
        </span>
        <span>{r.createdBy}</span>
      </div>
      {note && <div className="mt-1.5 line-clamp-2 text-[11px] text-red-600">{note}</div>}
    </Link>
  );
}
