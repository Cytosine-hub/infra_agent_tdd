"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoModule, Requirement, RequirementEvent, TestCase, User } from "@/lib/types";
import StatusBadge from "@/components/StatusBadge";
import AgentRuns from "@/components/AgentRuns";
import LocalAgentTask from "@/components/LocalAgentTask";
import ExecPlanCard from "@/components/ExecPlanCard";
import AttachmentsCard from "@/components/AttachmentsCard";
import MockupCard from "@/components/MockupCard";
import RequirementModuleScope from "@/components/RequirementModuleScope";
import type { AgentTaskRow } from "@/lib/db";
import type { ExecPlan } from "@/lib/types";

type ActionName =
  | "approve_requirement"
  | "reject_requirement"
  | "generate_tests"
  | "approve_tests"
  | "reject_tests"
  | "start_dev"
  | "retrigger_dev"
  | "review_pr"
  | "merge_pr"
  | "sync_github"
  | "save_tests"
  | "generate_mockup"
  | "abandon";

export default function RequirementDetail({
  initialRequirement,
  initialEvents,
  user,
  repoModules,
  moduleMapConfirmed,
}: {
  initialRequirement: Requirement;
  initialEvents: RequirementEvent[];
  user: User;
  repoModules: RepoModule[];
  moduleMapConfirmed: boolean;
}) {
  const [req, setReq] = useState(initialRequirement);
  const [events, setEvents] = useState(initialEvents);
  const [busy, setBusy] = useState<ActionName | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editingReq, setEditingReq] = useState(false);
  const [draftCases, setDraftCases] = useState<TestCase[]>([]);
  const [evaluating, setEvaluating] = useState(false);
  const [genActive, setGenActive] = useState(false); // 用例生成任务进行中

  // 后台任务完成后刷新需求与时间线（useCallback 保持引用稳定，避免子组件轮询抖动）
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/requirements/${initialRequirement.id}`);
    if (res.ok) {
      const data = await res.json();
      setReq(data.requirement);
      setEvents(data.events);
    }
  }, [initialRequirement.id]);

  // 统一任务活跃轮询：所有启动类按钮在对应任务执行中一律禁用（防重复触发）
  const [mockupTask, setMockupTask] = useState<AgentTaskRow | null>(null);
  const [taskActive, setTaskActive] = useState({
    dev: false,
    review: false,
    testcases: false,
    mockup: false,
    classify: false,
  });
  const activePrev = useRef("");
  useEffect(() => {
    let stop = false;
    const isActive = (t: AgentTaskRow | null) =>
      !!t && (t.status === "queued" || t.status === "running");
    const poll = () => {
      fetch(`/api/requirements/${initialRequirement.id}/agent-task`)
        .then((r) => (r.ok ? r.json() : {}))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((d: any) => {
          if (stop) return;
          setMockupTask(d.mockup ?? null);
          const next = {
            dev: isActive(d.task),
            review: isActive(d.review),
            testcases: isActive(d.testcases),
            mockup: isActive(d.mockup),
            classify: isActive(d.classify),
          };
          setTaskActive(next);
          setGenActive(next.testcases);
          const sig = JSON.stringify(next);
          // 任务活跃状态发生变化 → 刷新需求（状态流转/用例写入/渲染图生成）
          if (activePrev.current && activePrev.current !== sig) refresh();
          activePrev.current = sig;
        });
    };
    poll();
    const timer = setInterval(poll, 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [initialRequirement.id, refresh]);

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

        {req.status === "abandoned" && (
          <div className="mt-4 rounded-lg border border-zinc-300 bg-zinc-100 px-4 py-3 text-sm text-zinc-600">
            🗑 <strong>该需求已废弃</strong>：{req.rejectReason ?? "无原因"}。关联的
            Issue/PR/分支已清理。如需继续，请
            <a href={`/requirements/new?from=${req.id}`} className="mx-1 text-sky-600 hover:underline">
              拆解为更小的需求重新提交
            </a>
            。
          </div>
        )}

        {req.guardStatus === "rejected" && (
          <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            🛡️ <strong>安全审查未通过，Agent 任务不会执行</strong>：{req.guardReason}
            <div className="mt-1 text-xs text-red-500">
              本平台仅受理对系统内仓库的软件开发需求；如判定有误请修改需求描述后重新提交。
            </div>
          </div>
        )}

        {/* 开发↔审查闭环状态 */}
        {(req.status === "developing" || req.status === "in_review") && req.reviewVerdict && (
          <div
            className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
              req.reviewVerdict === "approved"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-700"
            }`}
          >
            {req.reviewVerdict === "approved" ? (
              <>
                ✅ 代码审查<strong>无阻断问题，可合并</strong>。若有非阻断【建议】已列在 PR
                评论中，可选择性处理，不阻断上线。
              </>
            ) : (
              <>
                ⛔ 代码审查发现<strong>阻断性问题</strong>
                {req.fixRounds > 0 && `，已自动修复 ${req.fixRounds} 轮`}
                {req.fixRounds >= 3
                  ? "。已达自动修复上限——多轮仍未通过通常说明需求偏大，建议拆解为更小的需求："
                  : "，系统正自动把阻断项喂回编码 Agent 修改并复审。"}
                {req.fixRounds >= 3 && isLead && (
                  <span className="mt-2 flex gap-2">
                    <a
                      href={`/requirements/new?from=${req.id}`}
                      className="btn-secondary !px-2.5 !py-1 text-xs"
                    >
                      ✂️ 拆解重提
                    </a>
                    <button
                      className="btn-danger !px-2.5 !py-1 text-xs"
                      disabled={busy !== null}
                      onClick={() =>
                        actWithReason("abandon", "废弃原因（将关闭关联 Issue/PR 并删除分支）：")
                      }
                    >
                      🗑 废弃需求
                    </button>
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {/* 需求内容（待审核/被驳回时提交人与组长可修改；驳回态保存即重新提交） */}
        {editingReq ? (
          <RequirementEditor
            req={req}
            onCancel={() => setEditingReq(false)}
            onSaved={(updated) => {
              setReq(updated);
              setEditingReq(false);
              refresh();
            }}
          />
        ) : (
          <section className="card mt-5 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-500">需求描述</h2>
              {(isRequester || isLead) &&
                ["submitted", "requirement_rejected"].includes(req.status) && (
                  <button
                    className="btn-secondary !px-2.5 !py-1 text-xs"
                    onClick={() => setEditingReq(true)}
                  >
                    ✏️ 修改需求{req.status === "requirement_rejected" ? "并重新提交" : ""}
                  </button>
                )}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{req.description}</p>
            {req.testScenarios && (
              <>
                <h2 className="mt-5 text-sm font-semibold text-zinc-500">需求方核心测试场景</h2>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{req.testScenarios}</p>
              </>
            )}
          </section>
        )}

        {/* 附件 */}
        <AttachmentsCard
          requirementId={req.id}
          canManage={isRequester || isLead}
        />

        <RequirementModuleScope
          key={`${req.scopeLockedAt ?? ""}-${req.moduleSuggestion?.moduleKey ?? ""}-${req.moduleSuggestion?.confidence ?? ""}`}
          requirement={req}
          modules={repoModules}
          mapConfirmed={moduleMapConfirmed}
          isLead={isLead}
          classifyActive={taskActive.classify}
          onSaved={(updated) => {
            setReq(updated);
            refresh();
          }}
        />

        {/* 前端渲染图（AI 判定前端需求后生成，供评审预览） */}
        <MockupCard
          requirementId={req.id}
          mockupTask={mockupTask}
          canGenerate={isRequester || isLead}
          onGenerate={() => {
            const extra = window.prompt("补充要求（可选，如：改为深色主题、突出图表区；直接确定则按需求生成）：");
            if (extra === null) return;
            act("generate_mockup", extra ? { extra } : {});
          }}
          busy={busy === "generate_mockup"}
        />

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

        {/* 本地 Agent 任务监控（用例生成 / 开发 / 审查，无任务时自动隐藏） */}
        <LocalAgentTask
          requirementId={req.id}
          canRetrigger={isLead && (req.status === "developing" || req.status === "in_review")}
          onRetrigger={() => act("retrigger_dev")}
          canReview={isLead && req.status === "in_review"}
          onReview={() => act("review_pr")}
          busy={busy === "retrigger_dev" || busy === "review_pr"}
          onTaskFinished={refresh}
        />

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
                label={
                  genActive || busy === "generate_tests" ? "🤖 测试用例生成中…" : "🤖 生成测试用例"
                }
                busy={genActive || busy === "generate_tests"}
                onClick={() => {
                  const extra = window.prompt("补充要求（可选，直接确定则按需求内容生成）：");
                  if (extra === null) return;
                  act("generate_tests", extra ? { extra } : {});
                }}
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
                  disabled={busy !== null || genActive}
                  onClick={() => {
                    const extra = window.prompt("补充要求（可选，如：增加并发场景用例；直接确定则按原需求重新生成）：");
                    if (extra === null) return;
                    act("generate_tests", extra ? { extra } : {});
                  }}
                >
                  {genActive ? "生成中…" : "🔄 重新生成"}
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
                disabled={taskActive.dev}
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

            {/* 开发中/审查中：组长可修改执行方案后重新触发（应对模型不可用等失败场景） */}
            {(req.status === "developing" || req.status === "in_review") && isLead && (
              <ExecPlanCard
                savedPlan={req.execPlan}
                onEvaluate={evaluatePlan}
                evaluating={evaluating}
                starting={busy === "retrigger_dev"}
                disabled={taskActive.dev || taskActive.review}
                onStart={(choice) => act("retrigger_dev", choice)}
                startLabel="🔁 重新触发开发（按上方方案）"
                startingLabel="触发中…"
              />
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

            {/* 废弃：组长在任何未完成状态可执行（典型：多轮修复未过，需拆解重提） */}
            {isLead && req.status !== "done" && req.status !== "abandoned" && (
              <button
                className="mt-2 text-xs text-zinc-400 hover:text-red-600 hover:underline"
                disabled={busy !== null}
                onClick={() =>
                  actWithReason("abandon", "废弃原因（将关闭关联 Issue/PR 并删除分支）：")
                }
              >
                🗑 废弃该需求…
              </button>
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

// 需求内容编辑器：待审核状态可修改；被驳回状态保存后自动重新提交审核
function RequirementEditor({
  req,
  onCancel,
  onSaved,
}: {
  req: Requirement;
  onCancel: () => void;
  onSaved: (updated: Requirement) => void;
}) {
  const [form, setForm] = useState({
    title: req.title,
    team: req.team,
    repo: req.repo,
    priority: req.priority,
    description: req.description,
    testScenarios: req.testScenarios,
  });
  const [teams, setTeams] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/teams")
      .then((r) => r.json())
      .then((d) => setTeams((d.teams ?? []).map((t: { name: string }) => t.name)));
    fetch("/api/repos?forUser=1")
      .then((r) => r.json())
      .then((d) => setRepos((d.repos ?? []).map((x: { fullName: string }) => x.fullName)));
  }, []);

  async function save() {
    setSaving(true);
    setErr("");
    const res = await fetch(`/api/requirements/${req.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setErr(data.error ?? "保存失败");
      return;
    }
    onSaved(data.requirement);
  }

  return (
    <section className="card mt-5 flex flex-col gap-4 border-sky-200 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-sky-700">✏️ 修改需求</h2>
        {req.status === "requirement_rejected" && (
          <span className="text-xs text-amber-600">保存后将重新提交审核</span>
        )}
      </div>
      <div>
        <label className="label">标题 *</label>
        <input
          className="input"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">小组</label>
          <select
            className="input"
            value={form.team}
            onChange={(e) => setForm({ ...form, team: e.target.value })}
          >
            {[form.team, ...teams.filter((t) => t !== form.team)].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">仓库</label>
          <select
            className="input"
            value={form.repo}
            onChange={(e) => setForm({ ...form, repo: e.target.value })}
          >
            {[form.repo, ...repos.filter((r) => r !== form.repo)].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">优先级</label>
          <select
            className="input"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: e.target.value as Requirement["priority"] })}
          >
            <option value="P0">P0 - 紧急</option>
            <option value="P1">P1 - 高</option>
            <option value="P2">P2 - 普通</option>
          </select>
        </div>
      </div>
      <div>
        <label className="label">需求描述 *</label>
        <textarea
          className="input min-h-32"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>
      <div>
        <label className="label">核心测试场景</label>
        <textarea
          className="input min-h-24"
          value={form.testScenarios}
          onChange={(e) => setForm({ ...form, testScenarios: e.target.value })}
        />
      </div>
      {err && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onCancel} disabled={saving}>
          取消
        </button>
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving
            ? "保存中…"
            : req.status === "requirement_rejected"
              ? "保存并重新提交"
              : "保存修改"}
        </button>
      </div>
    </section>
  );
}
