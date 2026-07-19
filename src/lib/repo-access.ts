import type { Repo, User } from "./types";

// 仓库归属规则：team 为空 = 公共仓库人人可用；
// 指定小组的仓库仅该组成员（及管理员）可选用。
export function canUseRepo(repo: Repo, user: User): string | null {
  if (!repo.team) return null;
  if (user.role === "admin") return null;
  return user.team === repo.team ? null : `该仓库仅限「${repo.team}」使用`;
}

export function selectableRepos(repos: Repo[], user: User): Repo[] {
  return repos.filter((r) => canUseRepo(r, user) === null);
}
