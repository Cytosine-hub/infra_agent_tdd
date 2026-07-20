import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addEvent, getRepoByName, getRequirement, updateRequirement } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { canPerform, nextTestApprovalState, type Action } from "@/lib/workflow";
import {
  abandonOnGithub,
  createIssueForRequirement,
  githubConfigured,
  mergePullRequest,
  syncIssueState,
} from "@/lib/github";
import {
  enqueueDevTask,
  enqueueMockupTask,
  enqueueReviewTask,
  enqueueTestcaseTask,
  ENGINES,
} from "@/lib/agent-runner";
import { STATUS_LABELS, type TestCase } from "@/lib/types";

const BodySchema = z.object({
  action: z.enum([
    "approve_requirement",
    "reject_requirement",
    "generate_tests",
    "approve_tests",
    "reject_tests",
    "start_dev",
    "retrigger_dev",
    "review_pr",
    "merge_pr",
    "sync_github",
    "save_tests",
    "generate_mockup",
    "abandon",
  ]),
  reason: z.string().optional(),
  engine: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  fallback: z.boolean().optional(),
  testCases: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        precondition: z.string(),
        steps: z.array(z.string()),
        expected: z.string(),
      })
    )
    .optional(),
});

// 需求工作流的所有动作入口。状态流转规则集中在 lib/workflow.ts。
export const POST = apiHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const id = Number((await ctx.params).id);
    const requirement = getRequirement(id);
    if (!requirement) return badRequest("需求不存在");

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) return badRequest("请求参数错误");
    const { action, reason, testCases } = parsed.data;

    // 已废弃的需求是终态：一切动作封禁（如需继续应拆解后重新提交）
    if (requirement.status === "abandoned") {
      return badRequest("该需求已废弃。如需继续，请拆解为更小的需求后重新提交。");
    }
    // 执行方案优先级：本次请求参数（人工修改）> 已保存方案（AI 评估）> 环境默认
    const plan = requirement.execPlan;
    const engine = parsed.data.engine ?? plan?.engine ?? process.env.AGENT_ENGINE ?? "claude";
    const model = parsed.data.model ?? plan?.model;
    const effort = parsed.data.effort ?? plan?.effort;
    if (!ENGINES[engine]) return badRequest(`不支持的引擎：${engine}`);

    // sync_github / save_tests / generate_mockup 不是纯状态机动作，单独处理
    if (action === "sync_github") {
      return handleSync(id);
    }
    if (action === "generate_mockup") {
      const canDo =
        user.username === requirement.createdBy ||
        user.role === "admin" ||
        (user.role === "lead" && user.team === requirement.team);
      if (!canDo) return forbidden("仅需求提交人或本组组长可生成渲染图");
      const t = enqueueMockupTask(id, parsed.data.engine);
      addEvent(id, "mockup_requested", user.username, `手动发起前端渲染图生成（${t.engine}）`);
      return ok(id);
    }
    if (action === "save_tests") {
      if (requirement.status !== "testcases_generated") {
        return badRequest("仅在用例待审核状态下可编辑用例");
      }
      updateRequirement(id, {
        testCases: testCases ?? [],
        leadApprovedTests: 0,
        requesterApprovedTests: 0,
      });
      addEvent(id, "tests_edited", user.username, "人工修订测试用例，审批状态已重置");
      return ok(id);
    }

    const denied = canPerform(action as Action, requirement, user);
    if (denied) return forbidden(denied);

    switch (action) {
      case "approve_requirement": {
        updateRequirement(id, { status: "requirement_approved", rejectReason: null });
        addEvent(id, "requirement_approved", user.username, "需求审核通过");
        // 审核通过即自动入队生成测试用例（无需再手动点击）
        try {
          const t = enqueueTestcaseTask(id);
          addEvent(id, "testcase_task_enqueued", "system", `审核通过，自动生成测试用例（${t.engine}）`);
        } catch (e) {
          console.error("自动生成用例入队失败:", e);
        }
        break;
      }

      case "reject_requirement":
        updateRequirement(id, { status: "requirement_rejected", rejectReason: reason ?? "" });
        addEvent(id, "requirement_rejected", user.username, `需求驳回：${reason ?? "无原因"}`);
        break;

      case "generate_tests": {
        // 异步：入队用例生成任务（默认 codex），由 runner 守护进程执行
        const t = enqueueTestcaseTask(id, parsed.data.engine);
        addEvent(id, "testcase_task_enqueued", user.username, `用例生成任务已入队（${t.engine}）`);
        break;
      }

      case "approve_tests": {
        const next = nextTestApprovalState(requirement, user);
        updateRequirement(id, next);
        addEvent(
          id,
          "tests_approved",
          user.username,
          next.status === "testcases_approved" ? "测试用例双审通过" : "测试用例单方通过，等待另一方审核"
        );
        break;
      }

      case "reject_tests":
        updateRequirement(id, {
          status: "testcases_rejected",
          rejectReason: reason ?? "",
          leadApprovedTests: 0,
          requesterApprovedTests: 0,
        });
        addEvent(id, "tests_rejected", user.username, `测试用例驳回：${reason ?? "无原因"}`);
        break;

      case "start_dev": {
        if (!githubConfigured()) {
          return badRequest("GitHub 未配置。请在 .env.local 中设置 GITHUB_TOKEN 后重启服务");
        }
        // 门禁：仓库入驻（建索引 + agent.md）完成前不能启动开发
        const repo = getRepoByName(requirement.repo);
        if (repo && repo.onboardStatus !== "ready") {
          const label =
            repo.onboardStatus === "failed"
              ? `入驻失败（${repo.onboardError}），请在仓库管理中重新入驻`
              : `仓库正在入驻中（${repo.onboardStep || "排队"}），请稍候再启动开发`;
          return badRequest(label);
        }
        const { issueNumber, issueUrl, branch } = await createIssueForRequirement(requirement);
        updateRequirement(id, {
          status: "developing",
          githubIssueNumber: issueNumber,
          githubIssueUrl: issueUrl,
          branch,
          // 新的开发周期：重置审查闭环状态
          reviewVerdict: "",
          reviewFeedback: "",
          fixRounds: 0,
        });
        addEvent(id, "dev_started", user.username, `已创建 Issue #${issueNumber}，分支 ${branch}`);
        // 记录最终采用的执行方案（可能被人工修改过），并调度本地 Agent
        if (parsed.data.engine || parsed.data.model || parsed.data.effort) {
          updateRequirement(id, {
            execPlan: {
              engine,
              model: model ?? "",
              effort: effort ?? "medium",
              rationale: plan?.rationale ?? "人工指定",
              source: "manual",
            },
          });
        }
        enqueueDevTask(id, engine, { model, effort, fallback: parsed.data.fallback });
        addEvent(
          id,
          "agent_task_enqueued",
          user.username,
          `本地 Agent 开发任务已入队（${engine}${model ? `/${model}` : ""}${effort ? `/${effort}` : ""}）`
        );
        break;
      }

      case "retrigger_dev": {
        if (!githubConfigured()) return badRequest("GitHub 未配置");
        // 人工修改过方案则保存，后续重试沿用
        if (parsed.data.engine || parsed.data.model || parsed.data.effort) {
          updateRequirement(id, {
            execPlan: {
              engine,
              model: model ?? "",
              effort: effort ?? "medium",
              rationale: plan?.rationale ?? "人工指定",
              source: "manual",
            },
          });
        }
        enqueueDevTask(id, engine, { model, effort, fallback: parsed.data.fallback });
        addEvent(
          id,
          "dev_retriggered",
          user.username,
          `重新触发本地 Agent 开发（${engine}${model ? `/${model}` : ""}${effort ? `/${effort}` : ""}）`
        );
        break;
      }

      case "review_pr": {
        if (!githubConfigured()) return badRequest("GitHub 未配置");
        const t = enqueueReviewTask(id, parsed.data.engine);
        addEvent(id, "review_requested", user.username, `发起 PR 审查（${t.engine}）`);
        break;
      }

      case "abandon": {
        updateRequirement(id, { status: "abandoned", rejectReason: reason ?? "需求废弃" });
        addEvent(id, "abandoned", user.username, `需求废弃：${reason ?? "无原因"}`);
        // GitHub 清理（关 PR / 删分支 / 关 Issue），best-effort
        try {
          await abandonOnGithub(requirement, reason ?? "需求废弃");
        } catch (e) {
          console.error("废弃时 GitHub 清理失败:", e);
        }
        break;
      }

      case "merge_pr": {
        if (!githubConfigured()) return badRequest("GitHub 未配置");
        const message = await mergePullRequest(requirement);
        updateRequirement(id, { status: "done" });
        addEvent(id, "pr_merged", user.username, message);
        break;
      }
    }
    return ok(id);
  }
);

async function handleSync(id: number): Promise<NextResponse> {
  const requirement = getRequirement(id)!;
  if (!githubConfigured()) return badRequest("GitHub 未配置");
  if (!requirement.githubIssueNumber) return badRequest("该需求尚未关联 GitHub Issue");
  const state = await syncIssueState(requirement);
  const patch: Record<string, unknown> = { prNumber: state.prNumber, prUrl: state.prUrl };
  let newStatus = requirement.status;
  if (state.merged || state.issueClosed) newStatus = "done";
  else if (state.prNumber) newStatus = "in_review";
  if (newStatus !== requirement.status) {
    patch.status = newStatus;
    addEvent(id, "status_synced", "system", `GitHub 同步：${STATUS_LABELS[newStatus]}`);
  }
  updateRequirement(id, patch);
  return ok(id);
}

function ok(id: number): NextResponse {
  return NextResponse.json({ requirement: getRequirement(id) });
}
