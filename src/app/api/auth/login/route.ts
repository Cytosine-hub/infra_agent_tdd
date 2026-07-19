import { NextRequest, NextResponse } from "next/server";
import { getUser, listUsers } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/session";
import { apiHandler, badRequest } from "@/lib/api";
import { enabledProviders } from "@/lib/oauth";

export const GET = apiHandler(async () => {
  return NextResponse.json({ users: listUsers(), providers: enabledProviders() });
});

export const POST = apiHandler(async (req: NextRequest) => {
  const { username } = (await req.json()) as { username?: string };
  if (!username) return badRequest("缺少 username");
  const user = getUser(username);
  if (!user) return badRequest("用户不存在");
  const res = NextResponse.json({ user });
  res.cookies.set(SESSION_COOKIE, user.username, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return res;
});
