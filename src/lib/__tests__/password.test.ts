import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../password";

describe("password 哈希", () => {
  it("正确密码验证通过、错误密码失败", () => {
    const h = hashPassword("s3cret!");
    expect(verifyPassword("s3cret!", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });

  it("同一密码两次哈希不同（随机盐）", () => {
    expect(hashPassword("x")).not.toBe(hashPassword("x"));
  });

  it("空/非法存储值一律不通过", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "plaintext")).toBe(false);
    expect(verifyPassword("x", "scrypt$onlyonepart")).toBe(false);
  });
});
