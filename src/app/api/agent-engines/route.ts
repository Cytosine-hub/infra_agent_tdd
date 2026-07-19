import { NextResponse } from "next/server";
import { availableEngines } from "@/lib/agent-runner";
import { apiHandler } from "@/lib/api";

export const GET = apiHandler(async () => {
  return NextResponse.json({ engines: await availableEngines() });
});
