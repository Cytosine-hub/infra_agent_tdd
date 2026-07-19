import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { authorizeRedirect, providerConfig, type OAuthProviderName } from "@/lib/oauth";

// 第一步：跳转到 GitHub / GitLab 授权页
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const provider = (await ctx.params).provider as OAuthProviderName;
  if (!["github", "gitlab"].includes(provider) || !providerConfig(provider)) {
    return NextResponse.json({ error: "该登录方式未配置" }, { status: 400 });
  }
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${req.nextUrl.origin}/api/auth/oauth/${provider}/callback`;
  const res = NextResponse.redirect(authorizeRedirect(provider, redirectUri, state));
  res.cookies.set("oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
