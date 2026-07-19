import { cookies } from "next/headers";
import { getUser } from "./db";
import type { User } from "./types";

const COOKIE = "portal_user";

// 演示用轻量会话：cookie 只存用户名，生产环境应替换为 LDAP/SSO + 签名会话
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const username = jar.get(COOKIE)?.value;
  if (!username) return null;
  return getUser(username);
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("未登录");
  }
}

export const SESSION_COOKIE = COOKIE;
