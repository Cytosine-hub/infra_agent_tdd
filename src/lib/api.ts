import { NextResponse } from "next/server";
import { UnauthorizedError } from "./session";

// 统一的 API 错误处理包装
export function apiHandler<T extends unknown[]>(
  fn: (...args: T) => Promise<NextResponse>
): (...args: T) => Promise<NextResponse> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return NextResponse.json({ error: "未登录" }, { status: 401 });
      }
      console.error(err);
      const message = err instanceof Error ? err.message : "服务器内部错误";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function forbidden(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 403 });
}
