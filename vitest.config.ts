import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "src") },
  },
  test: {
    // data/ 下是运行时产物（SQLite、Agent 工作区中 clone 的目标仓库），不属于本项目测试
    exclude: ["**/node_modules/**", "data/**"],
  },
});
