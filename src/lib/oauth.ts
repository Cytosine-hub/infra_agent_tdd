// GitHub / GitLab OAuth2 登录（轻量实现，不引入额外框架）。
// 配置环境变量后登录页自动出现对应按钮；内置账号登录始终保留。
//   GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET
//   GITLAB_OAUTH_CLIENT_ID / GITLAB_OAUTH_CLIENT_SECRET / GITLAB_URL（自建实例，默认 gitlab.com）

export type OAuthProviderName = "github" | "gitlab";

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
}

function gitlabBase(): string {
  return (process.env.GITLAB_URL ?? "https://gitlab.com").replace(/\/$/, "");
}

export function providerConfig(name: OAuthProviderName): ProviderConfig | null {
  if (name === "github") {
    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userUrl: "https://api.github.com/user",
      scope: "read:user",
      clientId,
      clientSecret,
    };
  }
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITLAB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    authorizeUrl: `${gitlabBase()}/oauth/authorize`,
    tokenUrl: `${gitlabBase()}/oauth/token`,
    userUrl: `${gitlabBase()}/api/v4/user`,
    scope: "read_user",
    clientId,
    clientSecret,
  };
}

export function enabledProviders(): OAuthProviderName[] {
  return (["github", "gitlab"] as const).filter((p) => providerConfig(p) !== null);
}

export function authorizeRedirect(
  name: OAuthProviderName,
  redirectUri: string,
  state: string
): string {
  const cfg = providerConfig(name)!;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: cfg.scope,
    state,
  });
  return `${cfg.authorizeUrl}?${params}`;
}

export async function exchangeCode(
  name: OAuthProviderName,
  code: string,
  redirectUri: string
): Promise<{ login: string; displayName: string }> {
  const cfg = providerConfig(name)!;
  const tokenRes = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!token.access_token) {
    throw new Error(`OAuth 换取 token 失败：${token.error ?? tokenRes.status}`);
  }
  const userRes = await fetch(cfg.userUrl, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) throw new Error(`获取 ${name} 用户信息失败：${userRes.status}`);
  const u = (await userRes.json()) as { login?: string; username?: string; name?: string };
  const login = name === "github" ? u.login : u.username;
  if (!login) throw new Error(`未取到 ${name} 用户名`);
  return { login, displayName: u.name || login };
}
