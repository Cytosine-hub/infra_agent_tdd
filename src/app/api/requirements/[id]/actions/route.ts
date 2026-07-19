import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addEvent, getRequirement, updateRequirement } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { canPerform, nextTestApprovalState, type Action } from "@/lib/workflow";
import { generateTestCases } from "@/lib/testcase-gen";
import { createIssueForRequirement, githubConfigured, syncIssueState } from "@/lib/github";
import { enqueueDevTask, ENGINES } from "@/lib/agent-runner";
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
    "sync_github",
    "save_tests",
  ]),
  reason: z.string().optional(),
  engine: z.string().optional(),
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
    const engine = parsed.data.engine ?? process.env.AGENT_ENGINE ?? "claude";
    if (!ENGINES[engine]) return badRequest(`不支持的引擎：${engine}`);

    // sync_github / save_tests 不是纯状态机动作，单独处理
    if (action === "sync_github") {
      return handleSync(id);
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
      case "approve_requirement":
        updateRequirement(id, { status: "requirement_approved", rejectReason: null });
        addEvent(id, "requirement_approved", user.username, "需求审核通过");
        break;

      case "reject_requirement":
        updateRequirement(id, { status: "requirement_rejected", rejectReason: reason ?? "" });
        addEvent(id, "requirement_rejected", user.username, `需求驳回：${reason ?? "无原因"}`);
        break;

      case "generate_tests": {
        const { testCases: generated, source } = await generateTestCases(requirement);
        updateRequirement(id, {
          status: "testcases_generated",
          testCases: generated as TestCase[],
          leadApprovedTests: 0,
          requesterApprovedTests: 0,
        });
        addEvent(
          id,
          "tests_generated",
          user.username,
          source === "claude" ? "Claude 生成测试用例" : "本地模板生成测试用例（未配置 ANTHROPIC_API_KEY）"
        );
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
        const { issueNumber, issueUrl, branch } = await createIssueForRequirement(requirement);
        updateRequirement(id, {
          status: "developing",
          githubIssueNumber: issueNumber,
          githubIssueUrl: issueUrl,
          branch,
        });
        addEvent(id, "dev_started", user.username, `已创建 Issue #${issueNumber}，分支 ${branch}`);
        // 调度本地 Agent（claude / codex CLI）执行开发
        enqueueDevTask(id, engine);
        addEvent(id, "agent_task_enqueued", user.username, `本地 Agent 开发任务已入队（${engine}）`);
        break;
      }

      case "retrigger_dev": {
        if (!githubConfigured()) return badRequest("GitHub 未配置");
        enqueueDevTask(id, engine);
        addEvent(id, "dev_retriggered", user.username, `重新触发本地 Agent 开发（${engine}）`);
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
