import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { apiHandler } from "@/lib/api";

export const GET = apiHandler(async () => {
  const user = await requireUser();
  return NextResponse.json({ user });
});
