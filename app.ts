// The forge's HTTP surface: REST v3 in this file; git smart HTTP, GraphQL and MCP are wired
// in from their own modules. Every reply carries an X-GitHub-Request-Id header, every REST
// reply is JSON, and every error body is {"message": string}, as the wire contract requires.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { forge, clock, type Repo, type Issue, type Pull } from './store.ts';
import { handleGit } from './git.ts';
import { pullFiles, mergePull, filesAt as filesAtCommit } from './merge.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

export type SendJson = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
export type SendRaw = (res: ServerResponse, status: number, data: Buffer, contentType: string, headers?: Record<string, string>) => void;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `FORGE-${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, data: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    'x-github-request-id': `FORGE-${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`,
    ...headers,
  });
  res.end(data);
}

const notFound = (res: ServerResponse): void => sendJson(res, 404, { message: 'Not Found' });

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Record<string, unknown> | null;
  rawBody: Buffer;
  base: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** The login every response reports for the token's owner. */
function viewerLogin(pathOwner?: string): string {
  return forge.viewerLogin ?? pathOwner ?? 'viewer';
}

function userJson(login: string): Record<string, unknown> {
  return { login, id: 1000, type: 'User', site_admin: false };
}

function repoJson(repo: Repo, ownerSeg?: string): Record<string, unknown> {
  const login = viewerLogin(ownerSeg);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: userJson(login),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `https://forge.local/${login}/${repo.name}`,
    clone_url: `https://forge.local/${login}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (!label) return null;
  return { id: label.id, node_id: `L_${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)).filter((x) => x !== null),
    user: userJson(viewerLogin()),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://forge.local/${viewerLogin()}/${repo.name}/issues/${issue.number}`,
  };
}

function refJson(repo: Repo, refName: string, sha: string): Record<string, unknown> {
  const short = refName.replace(/^refs\/heads\//, '');
  return {
    label: `${viewerLogin()}:${short}`,
    ref: short,
    sha,
    user: userJson(viewerLogin()),
    repo: repoJson(repo),
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: false,
    head: refJson(repo, pull.headRef, pull.headSha),
    base: refJson(repo, pull.baseRef, pull.baseSha),
    user: userJson(viewerLogin()),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? true : null,
    mergeable_state: pull.merged ? 'clean' : 'unknown',
    comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://forge.local/${viewerLogin()}/${repo.name}/pull/${pull.number}`,
  };
}

/** Resolve a ref-ish (branch name, full ref, or sha) to a commit sha in this repo. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (!ref) return repo.branchTip(repo.defaultBranch);
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  if (repo.branchTip(ref)) return repo.branchTip(ref);
  if (/^[0-9a-f]{40}$/i.test(ref) && forge.objects.typeOf(ref) === 'commit') return ref;
  return null;
}

/** The flat file map at a commit (or an empty map for an unborn branch). */
function filesAt(_repo: Repo, commitSha: string | null): Map<string, { sha: string; mode: string }> {
  return filesAtCommit(commitSha);
}

/** Parse a git identity line "Name <email> 1700000000 +0000" for the REST commit shape. */
function identityJson(ident: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(ident);
  if (!m) return { name: ident, email: '', date: clock.peekIso() };
  return { name: m[1] as string, email: m[2] as string, date: new Date(Number(m[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

function commitJson(sha: string): Record<string, unknown> | null {
  const commit = forge.objects.readCommit(sha);
  if (!commit) return null;
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: identityJson(commit.author),
      committer: identityJson(commit.committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: commit.parents.map((p) => ({ sha: p })),
  };
}

// --------------------------------------------------------------------------- REST routing

function pageParams(url: URL): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(ctx: Ctx, items: T[], path: string): { slice: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx.url);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  const link = (p: number, rel: string): string => `<${ctx.base}${path}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
  if (page < totalPages) links.push(link(page + 1, 'next'), link(totalPages, 'last'));
  if (page > 1) links.push(link(page - 1, 'prev'), link(1, 'first'));
  return { slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

async function handleRest(ctx: Ctx, segments: string[]): Promise<void> {
  const { res, url } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body ?? {};
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      authorizations_url: '/api/v3/authorizations',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
  }

  if (rest[0] === 'rate_limit' && rest.length === 1) {
    return sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1893456000 } }, rate: { limit: 5000, remaining: 4999, reset: 1893456000 } });
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, { ...userJson(viewerLogin()), name: 'Forge Viewer' });
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = forge.listRepos().map((r) => repoJson(r));
      const { slice, headers } = paginate(ctx, all, '/api/v3/user/repos');
      return sendJson(res, 200, slice, headers);
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (!name) return sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'missing_field', field: 'name' }] });
      if (forge.getRepo(name)) return sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
      const repo = forge.createRepo(name, {
        description: str(body.description),
        isPrivate: bool(body.private) ?? false,
        defaultBranch: str(body.default_branch) ?? 'main',
      });
      return sendJson(res, 201, repoJson(repo));
    }
    return notFound(res);
  }

  if (rest[0] !== 'repos' || rest.length < 3) return notFound(res);
  const ownerSeg = rest[1] as string;
  const repoName = rest[2] as string;
  const repo = forge.getRepo(repoName);
  // Ownership: the repo belongs to the token's login. Learn that login from the first
  // resolving owner segment; any other owner segment is a 404, never a 403.
  if (repo && forge.viewerLogin === null) forge.viewerLogin = ownerSeg;
  if (!repo || (forge.viewerLogin !== null && ownerSeg !== forge.viewerLogin)) return notFound(res);
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo, ownerSeg));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        forge.repos.delete(repo.name);
        repo.name = body.name;
        forge.repos.set(repo.name, repo);
      }
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
      repo.updatedAt = clock.iso();
      return sendJson(res, 200, repoJson(repo, ownerSeg));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.name);
      return sendJson(res, 204, null);
    }
    return notFound(res);
  }

  if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
    return sendJson(res, 200, branches);
  }

  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2 && method === 'POST') {
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref || !sha || forge.objects.typeOf(sha) !== 'commit') {
      return sendJson(res, 422, { message: 'Validation Failed.', errors: [{ resource: 'Ref', code: 'custom', field: 'sha', message: 'not a commit' }] });
    }
    repo.refs.set(ref, sha);
    return sendJson(res, 201, { ref, node_id: `REF_${ref}`, object: { type: 'commit', sha } });
  }

  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, url.searchParams.get('sha'));
    if (!tip) return sendJson(res, 200, []);
    const shas = forge.objects.log(tip, 500);
    const all = shas.map(commitJson).filter((c) => c !== null);
    const { slice, headers } = paginate(ctx, all, `/api/v3/repos/${ownerSeg}/${repoName}/commits`);
    return sendJson(res, 200, slice, headers);
  }

  if (tail[0] === 'contents') {
    return handleContents(ctx, repo, tail.slice(1).join('/'));
  }

  if (tail[0] === 'labels') return handleLabels(ctx, repo, tail);
  if (tail[0] === 'issues') return handleIssues(ctx, repo, ownerSeg, tail);
  if (tail[0] === 'pulls') return handlePulls(ctx, repo, ownerSeg, tail);

  return notFound(res);
}

function handleContents(ctx: Ctx, repo: Repo, rawPath: string): void {
  const { res, url } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body ?? {};
  const path = decodeURIComponent(rawPath).replace(/^\/+/, '');
  const objects = forge.objects;

  const branchForWrite = str(body.branch) ?? repo.defaultBranch;
  const refForRead = url.searchParams.get('ref') ?? str(body.branch) ?? repo.defaultBranch;

  if (method === 'GET') {
    const tip = resolveRef(repo, refForRead);
    if (!tip) return notFound(res);
    const commit = objects.readCommit(tip);
    if (!commit) return notFound(res);
    if (path === '') {
      const entries = objects.readTree(commit.tree).map((e) => ({
        name: e.name, path: e.name, sha: e.sha, size: 0, type: e.type === 'tree' ? 'dir' : 'file',
      }));
      return sendJson(res, 200, entries);
    }
    const parts = path.split('/');
    let treeSha = commit.tree;
    for (let i = 0; i < parts.length; i++) {
      const entry = objects.readTree(treeSha).find((e) => e.name === parts[i]);
      if (!entry) return notFound(res);
      if (i === parts.length - 1) {
        if (entry.type === 'tree') {
          const entries = objects.readTree(entry.sha).map((e) => ({
            name: e.name, path: `${path}/${e.name}`, sha: e.sha, size: 0, type: e.type === 'tree' ? 'dir' : 'file',
          }));
          return sendJson(res, 200, entries);
        }
        const blob = objects.read(entry.sha);
        if (!blob) return notFound(res);
        return sendJson(res, 200, {
          name: parts[i], path, sha: entry.sha, size: blob.data.length, type: 'file',
          encoding: 'base64', content: blob.data.toString('base64'),
        });
      }
      if (entry.type !== 'tree') return notFound(res);
      treeSha = entry.sha;
    }
    return notFound(res);
  }

  if (method === 'PUT') {
    const contentB64 = str(body.content);
    const message = str(body.message) ?? 'Update file';
    if (contentB64 === null) return sendJson(res, 422, { message: 'Validation Failed.', errors: [{ resource: 'Content', code: 'missing_field', field: 'content' }] });
    const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    let tip = repo.branchTip(branchForWrite);
    // A write naming a branch that does not exist yet starts it from the default
    // branch's tip (the suite creates pull-request head branches this way).
    if (!tip && branchForWrite !== repo.defaultBranch) {
      tip = repo.branchTip(repo.defaultBranch);
    }
    const files = filesAt(repo, tip);
    const existing = files.get(path);
    const givenSha = str(body.sha);
    if (existing && givenSha !== existing.sha) {
      return sendJson(res, 409, { message: `Conflict: the file's sha does not match.` });
    }
    const blobSha = objects.writeBlob(data);
    files.set(path, { sha: blobSha, mode: '100644' });
    const commitSha = objects.commitFiles(tip, files, message);
    repo.setBranch(branchForWrite, commitSha);
    const status = existing ? 200 : 201;
    return sendJson(res, status, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const message = str(body.message) ?? 'Delete file';
    const tip = repo.branchTip(branchForWrite);
    const files = filesAt(repo, tip);
    const existing = files.get(path);
    if (!tip || !existing) return notFound(res);
    const givenSha = str(body.sha);
    if (givenSha !== null && givenSha !== existing.sha) {
      return sendJson(res, 409, { message: `Conflict: the file's sha does not match.` });
    }
    files.delete(path);
    const commitSha = objects.commitFiles(tip, files, message);
    repo.setBranch(branchForWrite, commitSha);
    return sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
  }

  return notFound(res);
}

function handleLabels(ctx: Ctx, repo: Repo, tail: string[]): void {
  const { res } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body ?? {};
  if (tail.length === 1) {
    if (method === 'GET') return sendJson(res, 200, [...repo.labels.keys()].map((n) => labelJson(repo, n)));
    if (method === 'POST') {
      const name = str(body.name);
      if (!name) return sendJson(res, 422, { message: 'Validation Failed.', errors: [{ resource: 'Label', code: 'missing_field', field: 'name' }] });
      if (repo.labels.has(name)) return sendJson(res, 422, { message: 'Validation Failed.', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
      const color = (str(body.color) ?? 'ededed').replace(/^#/, '').toLowerCase();
      repo.labels.set(name, { id: repo.nextLabelId++, name, color, description: str(body.description) });
      return sendJson(res, 201, labelJson(repo, name));
    }
  }
  return notFound(res);
}

function labelNamesOf(repo: Repo, body: Record<string, unknown>): string[] | 'unknown' {
  const raw = body.labels;
  if (raw === undefined) return [];
  const names: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') names.push(item);
      else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') names.push((item as Record<string, unknown>).name as string);
    }
  }
  for (const name of names) if (!repo.labels.has(name)) return 'unknown';
  return names;
}

function handleIssues(ctx: Ctx, repo: Repo, ownerSeg: string, tail: string[]): void {
  const { res, url } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body ?? {};

  if (tail.length === 1) {
    if (method === 'POST') {
      const title = str(body.title);
      if (!title) return sendJson(res, 422, { message: 'Validation Failed.', errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] });
      const labels = labelNamesOf(repo, body);
      if (labels === 'unknown') return sendJson(res, 422, { message: 'Validation Failed.', errors: [{ resource: 'Label', code: 'invalid', field: 'name' }] });
      const now = clock.iso();
      const issue: Issue = {
        id: forge.globalId(), number: repo.nextNumber++, title, body: str(body.body),
        state: 'open', labels, isPull: false, createdAt: now, updatedAt: now, comments: [],
      };
      repo.issues.set(issue.number, issue);
      return sendJson(res, 201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      const direction = url.searchParams.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const all = list.map((i) => issueJson(repo, i));
      const { slice, headers } = paginate(ctx, all, `/api/v3/repos/${ownerSeg}/${repo.name}/issues`);
      return sendJson(res, 200, slice, headers);
    }
    return notFound(res);
  }

  const number = Number(tail[1]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (tail.length === 2) {
    if (!issue) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string' || body.body === null) issue.body = body.body as string | null;
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (body.labels !== undefined) {
        const labels = labelNamesOf(repo, body);
        if (labels === 'unknown') return sendJson(res, 422, { message: 'Validation Failed.', errors: [{ resource: 'Label', code: 'invalid', field: 'name' }] });
        issue.labels = labels;
      }
      issue.updatedAt = clock.iso();
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return notFound(res);
  }

  if (tail.length === 3 && tail[2] === 'comments') {
    if (!issue) return notFound(res);
    if (method === 'POST') {
      const text = str(body.body);
      if (text === null) return sendJson(res, 422, { message: 'Validation Failed.', errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }] });
      const now = clock.iso();
      const comment = { id: forge.globalId(), body: text, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      issue.updatedAt = now;
      return sendJson(res, 201, { id: comment.id, body: comment.body, user: userJson(viewerLogin()), created_at: comment.createdAt, updated_at: comment.updatedAt });
    }
    if (method === 'GET') {
      return sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: userJson(viewerLogin()), created_at: c.createdAt, updated_at: c.updatedAt })));
    }
  }
  return notFound(res);
}

function handlePulls(ctx: Ctx, repo: Repo, ownerSeg: string, tail: string[]): void {
  const { res, url } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body ?? {};

  const stripOwner = (ref: string): string => (ref.includes(':') ? (ref.split(':').pop() as string) : ref);

  if (tail.length === 1) {
    if (method === 'POST') {
      const title = str(body.title);
      const headRaw = str(body.head);
      const baseRaw = str(body.base) ?? repo.defaultBranch;
      if (!title || !headRaw) return sendJson(res, 422, { message: 'Validation Failed.', errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'title' }] });
      const headRef = stripOwner(headRaw);
      const baseRef = stripOwner(baseRaw);
      const headSha = repo.branchTip(headRef);
      const baseSha = repo.branchTip(baseRef);
      if (!headSha || !baseSha) return sendJson(res, 422, { message: 'Validation Failed.', errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head' }] });
      const now = clock.iso();
      const pull: Pull = {
        id: forge.globalId(), number: repo.nextNumber++, title, body: str(body.body),
        state: 'open', headRef, headSha, baseRef, baseSha, merged: false, mergedAt: null,
        mergeCommitSha: null, createdAt: now, updatedAt: now, isPull: true,
      };
      repo.pulls.set(pull.number, pull);
      return sendJson(res, 201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      const all = list.map((p) => pullJson(repo, p));
      const { slice, headers } = paginate(ctx, all, `/api/v3/repos/${ownerSeg}/${repo.name}/pulls`);
      return sendJson(res, 200, slice, headers);
    }
    return notFound(res);
  }

  const number = Number(tail[1]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (tail.length === 2) {
    if (!pull) return notFound(res);
    if (method === 'GET') {
      pull.headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
      if (pull.state === 'open') pull.baseSha = repo.branchTip(pull.baseRef) ?? pull.baseSha;
      return sendJson(res, 200, pullJson(repo, pull));
    }
    return notFound(res);
  }

  if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
    if (!pull) return notFound(res);
    pull.headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
    return sendJson(res, 200, pullFiles(repo, pull));
  }

  if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
    if (!pull) return notFound(res);
    if (pull.merged || pull.state === 'closed') {
      return sendJson(res, 405, { message: 'Pull Request is not mergeable.' });
    }
    pull.headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
    const method2 = str(body.merge_method) ?? 'merge';
    const result = mergePull(repo, pull, method2 === 'merge' ? 'merge' : 'squash');
    if (result === 'conflict') {
      return sendJson(res, 405, { message: 'Pull Request has merge conflicts.' });
    }
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = clock.iso();
    pull.updatedAt = pull.mergedAt;
    pull.mergeCommitSha = result;
    return sendJson(res, 200, { sha: result, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound(res);
}

// --------------------------------------------------------------------------- server

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const rawBody = await readBody(req);
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        return sendJson(res, 400, { message: 'Bad Request' });
      }
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const host = req.headers.host ?? '127.0.0.1';
      const base = `http://${host}`;

      if (method === 'GET' && path === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }

      // Auth: everything else takes the trial's bearer token.
      const auth = req.headers.authorization ?? '';
      if (TOKEN !== '' && auth !== `Bearer ${TOKEN}`) {
        return sendJson(res, 401, { message: 'Bad credentials' });
      }

      // Parse a JSON body when one is present; malformed JSON is a 400 on API routes.
      let body: Record<string, unknown> | null = null;
      if (rawBody.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
        const text = rawBody.toString('utf8');
        try {
          const parsed = JSON.parse(text) as unknown;
          body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
        } catch {
          if (path.startsWith('/api/')) return sendJson(res, 400, { message: 'Problems parsing JSON' });
          body = null;
        }
      }

      const ctx: Ctx = { req, res, url, body, rawBody, base };
      const segments = path.split('/').filter((s) => s.length > 0);

      if (segments[0] === 'api' && segments[1] === 'v3') return handleRest(ctx, segments);
      if (path === '/api/graphql') return handleGraphQL(ctx, sendJson);
      if (path === '/mcp') return handleMcp(ctx, sendJson);
      if (handleGit(ctx, segments, sendRaw, sendJson)) return;

      return notFound(res);
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    });
  });
}
