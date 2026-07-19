import { NextResponse } from "next/server";
import { availableEngines, ENGINES } from "@/lib/agent-runner";
import { apiHandler } from "@/lib/api";

export const GET = apiHandler(async () => {
  const installed = await availableEngines();
  return NextResponse.json({
    engines: installed.map((name) => ({ name, models: ENGINES[name].models })),
  });
});
