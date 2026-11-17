// The forge's store: git objects (blob/tree/commit) in memory, repositories, issues, pull
// requests, labels and comments. One store backs every surface (REST, git HTTP, GraphQL, MCP),
// so an object created on one surface reads back identically on the others.

import { createHash } from 'node:crypto';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
  type: 'blob' | 'tree';
}

const ZERO_SHA = '0000000000000000000000000000000000000000';
export { ZERO_SHA };

/** Deterministic logical clock: starts at MAKEFUN_TRIAL_NOW when set, else a fixed epoch. */
export class Clock {
  private baseMs: number;
  private tick = 0;
  constructor() {
    const now = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = now ? Date.parse(now) : NaN;
    this.baseMs = Number.isFinite(parsed) ? parsed : Date.parse('2026-01-01T00:00:00Z');
  }
  /** Next timestamp as an ISO string; every call advances one second. */
  iso(): string {
    this.tick += 1;
    return new Date(this.baseMs + this.tick * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  /** Next timestamp as unix seconds (for git author/committer lines). */
  unix(): number {
    this.tick += 1;
    return Math.floor(this.baseMs / 1000) + this.tick;
  }
  /** Current ISO timestamp without advancing (reads stay stable). */
  peekIso(): string {
    return new Date(this.baseMs + this.tick * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

export const clock = new Clock();

/** Git's object id: sha1 of "<type> <length>\0" followed by the raw bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export class ObjectStore {
  private objects = new Map<string, { type: GitObjectType; data: Buffer }>();

  write(type: GitObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }
  read(sha: string): { type: GitObjectType; data: Buffer } | null {
    return this.objects.get(sha) ?? null;
  }
  has(sha: string): boolean {
    return this.objects.has(sha);
  }
  typeOf(sha: string): GitObjectType | null {
    return this.objects.get(sha)?.type ?? null;
  }

  writeBlob(content: Buffer): string {
    return this.write('blob', content);
  }
  blobText(sha: string): string | null {
    const obj = this.read(sha);
    return obj && obj.type === 'blob' ? obj.data.toString('utf8') : null;
  }

  /** Serialize tree entries (git sorts by name with directories as name+"/"). */
  writeTree(entries: TreeEntry[]): string {
    const sorted = [...entries].sort((a, b) => {
      const an = a.type === 'tree' ? `${a.name}/` : a.name;
      const bn = b.type === 'tree' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.sha, 'hex'));
    }
    return this.write('tree', Buffer.concat(parts));
  }

  readTree(sha: string): TreeEntry[] {
    const obj = this.read(sha);
    if (!obj || obj.type !== 'tree') return [];
    const entries: TreeEntry[] = [];
    let i = 0;
    const data = obj.data;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      const mode = data.toString('utf8', i, sp);
      const nul = data.indexOf(0x00, sp);
      const name = data.toString('utf8', sp + 1, nul);
      const entrySha = data.toString('hex', nul + 1, nul + 21);
      entries.push({ mode, name, sha: entrySha, type: mode === '40000' ? 'tree' : 'blob' });
      i = nul + 21;
    }
    return entries;
  }

  /** Flatten a tree into a path -> blob entry map (recursive). */
  flattenTree(treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
    for (const e of this.readTree(treeSha)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.type === 'tree') this.flattenTree(e.sha, path, out);
      else out.set(path, { sha: e.sha, mode: e.mode });
    }
    return out;
  }

  /** Build (and store) a tree from a flat path -> {sha, mode} map. */
  buildTree(files: Map<string, { sha: string; mode: string }>): string {
    interface Dir { files: Map<string, { sha: string; mode: string }>; dirs: Map<string, Dir> }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of files) {
      const parts = path.split('/');
      let dir = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i] as string;
        if (!dir.dirs.has(part)) dir.dirs.set(part, { files: new Map(), dirs: new Map() });
        dir = dir.dirs.get(part) as Dir;
      }
      dir.files.set(parts[parts.length - 1] as string, entry);
    }
    const build = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: build(sub), type: 'tree' });
      for (const [name, f] of dir.files) entries.push({ mode: f.mode, name, sha: f.sha, type: 'blob' });
      return this.writeTree(entries);
    };
    return build(root);
  }

  writeCommit(info: CommitInfo): string {
    let text = `tree ${info.tree}\n`;
    for (const p of info.parents) text += `parent ${p}\n`;
    text += `author ${info.author}\ncommitter ${info.committer}\n\n${info.message}`;
    return this.write('commit', Buffer.from(text, 'utf8'));
  }

  readCommit(sha: string): CommitInfo | null {
    const obj = this.read(sha);
    if (!obj || obj.type !== 'commit') return null;
    const text = obj.data.toString('utf8');
    const split = text.indexOf('\n\n');
    const head = split === -1 ? text : text.slice(0, split);
    const message = split === -1 ? '' : text.slice(split + 2);
    const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) info.author = line.slice(7);
      else if (line.startsWith('committer ')) info.committer = line.slice(10);
    }
    return info;
  }

  /** The default identity stamped on forge-made commits (contents API, merges). */
  identity(): string {
    return `Forge Bot <forge@localhost> ${clock.unix()} +0000`;
  }

  /** Create a commit on top of `parent` (or a root commit when null) with a full file map. */
  commitFiles(parent: string | null, files: Map<string, { sha: string; mode: string }>, message: string): string {
    const tree = this.buildTree(files);
    const ident = this.identity();
    return this.writeCommit({
      tree,
      parents: parent ? [parent] : [],
      author: ident,
      committer: ident,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
  }

  /** Is `ancestor` reachable from `descendant` through parent links? */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const commit = this.readCommit(cur);
      if (commit) stack.push(...commit.parents);
    }
    return false;
  }

  /** Nearest common ancestor of two commits (BFS from both), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOf = (start: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const commit = this.readCommit(cur);
        if (commit) stack.push(...commit.parents);
      }
      return seen;
    };
    const fromA = ancestorsOf(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (fromA.has(cur)) return cur;
      const commit = this.readCommit(cur);
      if (commit) queue.push(...commit.parents);
    }
    return null;
  }

  /** Walk commits from a tip, newest first (topological by parent order). */
  log(tip: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const cur = stack.pop() as string;
      if (seen.has(cur) || !this.readCommit(cur)) continue;
      seen.add(cur);
      out.push(cur);
      const commit = this.readCommit(cur);
      if (commit) for (let i = commit.parents.length - 1; i >= 0; i--) stack.push(commit.parents[i] as string);
    }
    return out;
  }
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  isPull: false;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  isPull: true;
}

export class Repo {
  id: number;
  name: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs = new Map<string, string>(); // full ref name -> commit sha
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  nextNumber = 1; // issues and pulls share one sequence, as on GitHub
  nextIssueId = 1;
  nextCommentId = 1;
  nextLabelId = 1;

  constructor(id: number, name: string, opts: { description?: string | null; isPrivate?: boolean; defaultBranch?: string }) {
    this.id = id;
    this.name = name;
    this.description = opts.description ?? null;
    this.isPrivate = opts.isPrivate ?? false;
    this.defaultBranch = opts.defaultBranch ?? 'main';
    this.createdAt = clock.iso();
    this.updatedAt = this.createdAt;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }
  setBranch(branch: string, sha: string): void {
    this.refs.set(`refs/heads/${branch}`, sha);
    this.updatedAt = clock.peekIso();
  }
}

export class Forge {
  objects = new ObjectStore();
  repos = new Map<string, Repo>(); // by name; the token's viewer owns every repo here
  viewerLogin: string | null = null; // learned from the first /repos/{owner}/... path that resolves
  private nextRepoId = 1;
  private nextGlobalId = 100000;

  globalId(): number {
    this.nextGlobalId += 1;
    return this.nextGlobalId;
  }

  createRepo(name: string, opts: { description?: string | null; isPrivate?: boolean; defaultBranch?: string }): Repo {
    const repo = new Repo(this.nextRepoId++, name, opts);
    this.repos.set(name, repo);
    return repo;
  }
  getRepo(name: string): Repo | null {
    return this.repos.get(name) ?? null;
  }
  deleteRepo(name: string): void {
    this.repos.delete(name);
  }
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

export const forge = new Forge();
export { ZERO_SHA as ZERO };
