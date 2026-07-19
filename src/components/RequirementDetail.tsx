"use client";

import { useState } from "react";
import type { Requirement, RequirementEvent, TestCase, User } from "@/lib/types";
import StatusBadge from "@/components/StatusBadge";
import AgentRuns from "@/components/AgentRuns";
import LocalAgentTask from "@/components/LocalAgentTask";
import ExecPlanCard from "@/components/ExecPlanCard";
import type { ExecPlan } from "@/lib/types";

type ActionName =
  | "approve_requirement"
  | "reject_requirement"
  | "generate_tests"
  | "approve_tests"
  | "reject_tests"
  | "start_dev"
  | "retrigger_dev"
  | "merge_pr"
  | "sync_github"
  | "save_tests";

export default function RequirementDetail({
  initialRequirement,
  initialEvents,
  user,
}: {
  initialRequirement: Requirement;
  initialEvents: RequirementEvent[];
  user: User;
}) {
  const [req, setReq] = useState(initialRequirement);
  const [events, setEvents] = useState(initialEvents);
  const [busy, setBusy] = useState<ActionName | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftCases, setDraftCases] = useState<TestCase[]>([]);
  const [evaluating, setEvaluating] = useState(false);

  async function evaluatePlan(): Promise<ExecPlan | null> {
    setEvaluating(true);
    setError("");
    try {
      const res = await fetch(`/api/requirements/${req.id}/evaluate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "评估失败");
        return null;
      }
      return data.plan as ExecPlan;
    } finally {
      setEvaluating(false);
    }
  }

  const isLead = user.role === "admin" || (user.role === "lead" && user.team === req.team);
  const isRequester = user.username === req.createdBy;

  async function act(action: ActionName, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError("");
    const res = await fetch(`/api/requirements/${req.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) {
      setError(data.error ?? "操作失败");
      return false;
    }
    setReq(data.requirement);
    const evRes = await fetch(`/api/requirements/${req.id}`);
    if (evRes.ok) setEvents((await evRes.json()).events);
    return true;
  }

  function actWithReason(action: ActionName, prompt_text: string) {
    const reason = window.prompt(prompt_text);
    if (reason === null) return;
    act(action, { reason });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0">
        {/* 标题区 */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">
                <span className="mr-2 text-zinc-300">#{req.id}</span>
                {req.title}
              </h1>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
              <StatusBadge status={req.status} />
              <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs">{req.team}</span>
              <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs">{req.priority}</span>
              {req.repo && (
                <span className="rounded bg-sky-50 px-2 py-0.5 font-mono text-xs text-sky-700">
                  {req.repo}
                </span>
              )}
              <span className="text-xs">提交人：{req.createdBy}</span>
              <span className="text-xs">{req.createdAt}</span>
            </div>
          </div>
        </div>

        {req.rejectReason &&
          (req.status === "requirement_rejected" || req.status === "testcases_rejected") && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              驳回原因:{req.rejectReason}
            </div>
          )}

        {/* 需求内容 */}
        <section className="card mt-5 p-5">
          <h2 className="text-sm font-semibold text-zinc-500">需求描述</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{req.description}</p>
          {req.testScenarios && (
            <>
              <h2 className="mt-5 text-sm font-semibold text-zinc-500">需求方核心测试场景</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{req.testScenarios}</p>
            </>
          )}
        </section>

        {/* 测试用例 */}
        {req.testCases && (
          <section className="card mt-5 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-500">
                测试用例（{req.testCases.length} 条）
              </h2>
              {req.status === "testcases_generated" && !editing && (
                <button
                  className="btn-secondary !px-2.5 !py-1 text-xs"
                  onClick={() => {
                    setDraftCases(structuredClone(req.testCases!));
                    setEditing(true);
                  }}
                >
                  编辑用例
                </button>
              )}
            </div>

            {editing ? (
              <TestCaseEditor
                cases={draftCases}
                onChange={setDraftCases}
                onCancel={() => setEditing(false)}
                busy={busy === "save_tests"}
                onSave={async () => {
                  const ok = await act("save_tests", { testCases: draftCases });
                  if (ok) setEditing(false);
                }}
              />
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                {req.testCases.map((tc) => (
                  <div key={tc.id} className="rounded-lg border border-zinc-200 p-4">
                    <div className="text-sm font-medium">
                      <span className="mr-2 rounded bg-zinc-900 px-1.5 py-0.5 text-xs text-white">
                        {tc.id}
                      </span>
                      {tc.title}
                    </div>
                    <div className="mt-2 grid gap-1.5 text-xs text-zinc-600">
                      <div>
                        <span className="font-medium text-zinc-500">前置条件：</span>
                        {tc.precondition || "无"}
                      </div>
                      <div>
                        <span className="font-medium text-zinc-500">步骤：</span>
                        <ol className="ml-4 mt-0.5 list-decimal">
                          {tc.steps.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ol>
                      </div>
                      <div>
                        <span className="font-medium text-zinc-500">预期结果：</span>
                        {tc.expected}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {req.status === "testcases_generated" && (
              <div className="mt-4 flex items-center gap-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
                <span>
                  组长审核:{req.leadApprovedTests ? "✅ 已通过" : "⏳ 待审核"}
                </span>
                <span>
                  需求方审核:{req.requesterApprovedTests ? "✅ 已通过" : "⏳ 待审核"}
                </span>
              </div>
            )}
          </section>
        )}

        {/* GitHub 集成信息 */}
        {req.githubIssueUrl && (
          <section className="card mt-5 p-5">
            <h2 className="text-sm font-semibold text-zinc-500">GitHub 集成</h2>
            <div className="mt-2 grid gap-1.5 text-sm">
              <div>
                Issue：
                <a
                  href={req.githubIssueUrl}
                  target="_blank"
                  className="text-sky-600 hover:underline"
                >
                  #{req.githubIssueNumber}
                </a>
              </div>
              {req.branch && (
                <div>
                  开发分支：<code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{req.branch}</code>
                </div>
              )}
              {req.prUrl && (
                <div>
                  PR：
                  <a href={req.prUrl} target="_blank" className="text-sky-600 hover:underline">
                    #{req.prNumber}
                  </a>
                </div>
              )}
            </div>
          </section>
        )}

        {/* 本地 Agent 任务监控 */}
        {(req.status === "developing" || req.status === "in_review" || req.status === "done") &&
          req.githubIssueNumber && (
            <LocalAgentTask
              requirementId={req.id}
              canRetrigger={isLead && req.status !== "done"}
              onRetrigger={() => act("retrigger_dev")}
              busy={busy === "retrigger_dev"}
            />
          )}

        {/* GitHub Actions 运行监控（CI / 审查） */}
        {(req.status === "developing" || req.status === "in_review" || req.status === "done") &&
          req.githubIssueNumber && (
            <AgentRuns
              requirementId={req.id}
              canRetrigger={isLead && (req.status === "developing" || req.status === "in_review")}
              onRetrigger={() => act("retrigger_dev")}
              busy={busy === "retrigger_dev"}
            />
          )}
      </div>

      {/* 右侧：操作 + 时间线 */}
      <div className="flex flex-col gap-5">
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-zinc-500">操作</h2>
          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
          <div className="mt-3 flex flex-col gap-2">
            {(req.status === "submitted" || req.status === "requirement_rejected") && isLead && (
              <>
                <ActionButton
                  label="✅ 需求审核通过"
                  busy={busy === "approve_requirement"}
                  onClick={() => act("approve_requirement")}
                />
                {req.status === "submitted" && (
                  <button
                    className="btn-danger"
                    disabled={busy !== null}
                    onClick={() => actWithReason("reject_requirement", "请输入驳回原因：")}
                  >
                    ✕ 驳回需求
                  </button>
                )}
              </>
            )}

            {(req.status === "requirement_approved" || req.status === "testcases_rejected") && (
              <ActionButton
                label={busy === "generate_tests" ? "AI 生成中…" : "🤖 生成测试用例"}
                busy={busy === "generate_tests"}
                onClick={() => act("generate_tests")}
              />
            )}

            {req.status === "testcases_generated" && (
              <>
                {(isLead || isRequester) && (
                  <ActionButton
                    label="✅ 测试用例通过"
                    busy={busy === "approve_tests"}
                    onClick={() => act("approve_tests")}
                  />
                )}
                <button
                  className="btn-secondary"
                  disabled={busy !== null}
                  onClick={() => act("generate_tests")}
                >
                  🔄 重新生成
                </button>
                {(isLead || isRequester) && (
                  <button
                    className="btn-danger"
                    disabled={busy !== null}
                    onClick={() => actWithReason("reject_tests", "请输入驳回原因：")}
                  >
                    ✕ 驳回用例
                  </button>
                )}
              </>
            )}

            {req.status === "testcases_approved" && isLead && (
              <ExecPlanCard
                savedPlan={req.execPlan}
                onEvaluate={evaluatePlan}
                evaluating={evaluating}
                starting={busy === "start_dev"}
                onStart={(choice) => act("start_dev", choice)}
              />
            )}

            {req.status === "in_review" && isLead && req.prNumber && (
              <button
                className="btn-primary"
                disabled={busy !== null}
                onClick={() => {
                  if (window.confirm(`确认合并 PR #${req.prNumber}？将校验 CI 全绿后 squash 合并并删除分支。`)) {
                    act("merge_pr");
                  }
                }}
              >
                {busy === "merge_pr" ? "合并中…" : "✅ 合并 PR 上线"}
              </button>
            )}

            {(req.status === "developing" || req.status === "in_review") && (
              <button
                className="btn-secondary"
                disabled={busy !== null}
                onClick={() => act("sync_github")}
              >
                {busy === "sync_github" ? "同步中…" : "🔄 同步 GitHub 进度"}
              </button>
            )}

            {req.status === "done" && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-center text-sm text-emerald-700">
                🎉 已合并交付
              </div>
            )}
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-zinc-500">时间线</h2>
          <ol className="mt-3 flex flex-col gap-0">
            {events.map((ev, i) => (
              <li key={ev.id} className="relative flex gap-3 pb-4">
                {i < events.length - 1 && (
                  <span className="absolute left-[5px] top-3 h-full w-px bg-zinc-200" />
                )}
                <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-zinc-300" />
                <div className="text-xs">
                  <div className="text-zinc-700">{ev.detail}</div>
                  <div className="mt-0.5 text-zinc-400">
                    {ev.actor} · {ev.createdAt}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

function ActionButton({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button className="btn-primary" disabled={busy} onClick={onClick}>
      {label}
    </button>
  );
}

function TestCaseEditor({
  cases,
  onChange,
  onSave,
  onCancel,
  busy,
}: {
  cases: TestCase[];
  onChange: (c: TestCase[]) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  function update(i: number, patch: Partial<TestCase>) {
    const next = [...cases];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  }
  return (
    <div className="mt-3 flex flex-col gap-4">
      {cases.map((tc, i) => (
        <div key={i} className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <div className="flex items-center justify-between gap-2">
            <input
              className="input !w-24 text-xs"
              value={tc.id}
              onChange={(e) => update(i, { id: e.target.value })}
            />
            <button
              className="text-xs text-red-500 hover:underline"
              onClick={() => onChange(cases.filter((_, j) => j !== i))}
            >
              删除
            </button>
          </div>
          <input
            className="input mt-2"
            value={tc.title}
            placeholder="用例标题"
            onChange={(e) => update(i, { title: e.target.value })}
          />
          <input
            className="input mt-2"
            value={tc.precondition}
            placeholder="前置条件"
            onChange={(e) => update(i, { precondition: e.target.value })}
          />
          <textarea
            className="input mt-2 min-h-20"
            value={tc.steps.join("\n")}
            placeholder="步骤（每行一步）"
            onChange={(e) => update(i, { steps: e.target.value.split("\n") })}
          />
          <input
            className="input mt-2"
            value={tc.expected}
            placeholder="预期结果"
            onChange={(e) => update(i, { expected: e.target.value })}
          />
        </div>
      ))}
      <button
        className="btn-secondary"
        onClick={() =>
          onChange([
            ...cases,
            {
              id: `TC-${String(cases.length + 1).padStart(2, "0")}`,
              title: "",
              precondition: "",
              steps: [""],
              expected: "",
            },
          ])
        }
      >
        + 添加用例
      </button>
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button className="btn-primary" onClick={onSave} disabled={busy}>
          {busy ? "保存中…" : "保存用例"}
        </button>
      </div>
    </div>
  );
}
