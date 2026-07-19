import { NextRequest, NextResponse } from "next/server";
import { getRequirement, listEvents } from "@/lib/db";
import { apiHandler, badRequest } from "@/lib/api";

export const GET = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const id = Number((await ctx.params).id);
    const requirement = getRequirement(id);
    if (!requirement) return badRequest("需求不存在");
    return NextResponse.json({ requirement, events: listEvents(id) });
  }
);
