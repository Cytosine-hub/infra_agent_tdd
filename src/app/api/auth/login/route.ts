import { NextRequest, NextResponse } from "next/server";
import { verifyLogin } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/session";
import { apiHandler, badRequest } from "@/lib/api";
import { enabledProviders } from "@/lib/oauth";

// 登录页需要的信息：哪些第三方登录已启用（图标恒显示，未启用则禁用）
export const GET = apiHandler(async () => {
  const enabled = enabledProviders();
  return NextResponse.json({
    providers: [
      { name: "github", label: "GitHub", enabled: enabled.includes("github") },
      { name: "gitlab", label: "GitLab", enabled: enabled.includes("gitlab") },
    ],
  });
});

export const POST = apiHandler(async (req: NextRequest) => {
  const { username, password } = (await req.json()) as {
    username?: string;
    password?: string;
  };
  if (!username || !password) return badRequest("请输入用户名和密码");
  const user = verifyLogin(username, password);
  if (!user) return badRequest("用户名或密码错误");
  const res = NextResponse.json({ user });
  res.cookies.set(SESSION_COOKIE, user.username, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return res;
});
