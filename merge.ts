// Pull-request file diffs and merges, shared by the REST surface and GraphQL so both
// compute the same changed files and the same squash/merge commits.

import { forge, type Repo, type Pull } from './store.ts';

export function filesAt(commitSha: string | null): Map<string, { sha: string; mode: string }> {
  if (!commitSha) return new Map();
  const commit = forge.objects.readCommit(commitSha);
  if (!commit) return new Map();
  return forge.objects.flattenTree(commit.tree);
}

/** Line-multiset diff counts between two texts. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(oldText);
  const b = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of b) additions += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) deletions += Math.max(0, n - (b.get(line) ?? 0));
  return { additions, deletions };
}

/** Three-dot file changes between a pull's merge base and its head. */
export function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const base = forge.objects.mergeBase(pull.baseSha, pull.headSha) ?? pull.baseSha;
  const baseFiles = filesAt(base);
  const headFiles = filesAt(pull.headSha);
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.sha === after?.sha) continue;
    const oldText = before ? (forge.objects.blobText(before.sha) ?? '') : '';
    const newText = after ? (forge.objects.blobText(after.sha) ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    out.push({
      sha: after?.sha ?? '0000000000000000000000000000000000000000',
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

/** Would merging this pull conflict? A file both sides changed differently conflicts. */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  const mergeBase = forge.objects.mergeBase(baseTip, pull.headSha) ?? pull.baseSha;
  const baseFiles = filesAt(mergeBase);
  const headFiles = filesAt(pull.headSha);
  const curFiles = filesAt(baseTip);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...curFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.sha;
    const h = headFiles.get(path)?.sha;
    const c = curFiles.get(path)?.sha;
    if (h === b) continue;
    if (c === b || c === h) continue;
    return true;
  }
  return false;
}

/**
 * Squash/merge a pull into its base branch. Returns the new commit sha, or 'conflict'.
 * Per-file three-way merge from the merge base: a file both sides changed differently
 * is a conflict; anything else resolves to the changed side.
 */
export function mergePull(repo: Repo, pull: Pull, method: string): string | 'conflict' {
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  const mergeBase = forge.objects.mergeBase(baseTip, pull.headSha) ?? pull.baseSha;
  const baseFiles = filesAt(mergeBase);
  const headFiles = filesAt(pull.headSha);
  const curFiles = filesAt(baseTip);
  const merged = new Map(curFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...curFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.sha;
    const h = headFiles.get(path)?.sha;
    const c = curFiles.get(path)?.sha;
    if (h === b) continue; // head did not change it; keep current
    if (c === b || c === h) {
      const entry = headFiles.get(path);
      if (entry) merged.set(path, entry);
      else merged.delete(path);
      continue;
    }
    return 'conflict'; // both sides changed it differently
  }
  const message = method === 'merge'
    ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`
    : `${pull.title} (#${pull.number})\n${pull.body ? `\n${pull.body}\n` : ''}`;
  const parents = method === 'merge' ? [baseTip, pull.headSha] : [baseTip];
  const tree = forge.objects.buildTree(merged);
  const ident = forge.objects.identity();
  const sha = forge.objects.writeCommit({ tree, parents, author: ident, committer: ident, message });
  repo.setBranch(pull.baseRef, sha);
  return sha;
}
