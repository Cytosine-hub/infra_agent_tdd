import { NextRequest, NextResponse } from "next/server";
import { addUser, getUser, getUserByProvider } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/session";
import { exchangeCode, providerConfig, type OAuthProviderName } from "@/lib/oauth";

// 第二步：授权回调。首次登录自动创建账号（组员/未分配），
// 之后由管理员在「账号管理」中绑定角色与小组；再次登录直接复用绑定关系。
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const provider = (await ctx.params).provider as OAuthProviderName;
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get("oauth_state")?.value;

  const fail = (msg: string) =>
    NextResponse.redirect(`${url.origin}/login?error=${encodeURIComponent(msg)}`);

  if (!providerConfig(provider)) return fail("该登录方式未配置");
  if (!code || !state || state !== cookieState) return fail("OAuth 状态校验失败，请重试");

  try {
    const redirectUri = `${url.origin}/api/auth/oauth/${provider}/callback`;
    const { login, displayName } = await exchangeCode(provider, code, redirectUri);

    let user = getUserByProvider(provider, login);
    if (!user) {
      // 用户名加提供方前缀避免与内置账号冲突
      let username = `${provider === "github" ? "gh" : "gl"}_${login}`;
      if (getUser(username)) username = `${username}_${Date.now() % 10000}`;
      user = addUser({
        username,
        displayName,
        role: "member",
        team: "未分配",
        provider,
        providerLogin: login,
      });
    }

    const res = NextResponse.redirect(`${url.origin}/`);
    res.cookies.set(SESSION_COOKIE, user.username, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    res.cookies.set("oauth_state", "", { path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    console.error(err);
    return fail(err instanceof Error ? err.message : "OAuth 登录失败");
  }
}
