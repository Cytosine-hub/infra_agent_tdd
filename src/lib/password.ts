import crypto from "node:crypto";

// 密码哈希：scrypt + 随机盐（Node 内置，无外部依赖）。存储格式 scrypt$<salt>$<hash>。
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const [, salt, hash] = parts;
  const calc = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(calc, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 内置账号默认密码（首次启动/迁移用；上线前应要求改密）
export const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD ?? "portal123";
