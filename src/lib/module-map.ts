import type { RepoModule } from "./types";

export type RepoModuleCandidate = Pick<
  RepoModule,
  "moduleKey" | "name" | "paths" | "description"
>;

export function normalizeRepoPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isRepoRelativeGlob(value: string): boolean {
  const path = normalizeRepoPath(value);
  if (!path || path.length > 300 || path.startsWith("/") || path.includes("\0")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return !path.split("/").some((part) => part === "..");
}

export function normalizeRepoPaths(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map(normalizeRepoPath)
        .filter(isRepoRelativeGlob)
    )
  );
}

function normalizeModuleKey(value: unknown, index: number): string {
  if (typeof value !== "string") return `module-${index + 1}`;
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return key || `module-${index + 1}`;
}

export function parseRepoModuleCandidates(raw: string): RepoModuleCandidate[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("模块地图输出中未找到 JSON 数组");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("模块地图输出不是数组");

  const used = new Set<string>();
  const modules: RepoModuleCandidate[] = [];
  parsed.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    let moduleKey = normalizeModuleKey(record.module_key ?? record.moduleKey, index);
    while (used.has(moduleKey)) moduleKey = `${moduleKey}-${index + 1}`;
    const paths = normalizeRepoPaths(record.paths);
    const name = typeof record.name === "string" ? record.name.trim().slice(0, 100) : "";
    if (!name || paths.length === 0) return;
    used.add(moduleKey);
    modules.push({
      moduleKey,
      name,
      paths,
      description:
        typeof record.description === "string" ? record.description.trim().slice(0, 1000) : "",
    });
  });
  if (modules.length === 0) throw new Error("模块地图没有有效候选");
  return modules;
}
