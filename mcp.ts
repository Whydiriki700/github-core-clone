// MCP over Streamable HTTP: JSON-RPC 2.0 at /mcp. Speaks the 2026-07-28 revision through
// server/discover and the handshake revisions through initialize. The six tools act on the
// same store as REST, so an object created here reads back over /api/v3 unchanged.

import type { ServerResponse } from 'node:http';
import { forge, clock, type Repo, type Issue, type Pull } from './store.ts';
import { mergePull } from './merge.ts';
import type { Ctx, SendJson } from './app.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number, squashing its commits.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// The tools/list answer is a constant: two calls must return it byte for byte.
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

function viewerLogin(): string {
  return forge.viewerLogin ?? 'viewer';
}

function repoResult(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${viewerLogin()}/${repo.name}`,
    owner: { login: viewerLogin(), id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueResult(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: viewerLogin() },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    repository: repo.name,
  };
}

function pullResult(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    repository: repo.name,
  };
}

class ToolFailure extends Error {}

function resolveRepo(args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : null;
  const name = typeof args.repo === 'string' ? args.repo : null;
  if (!name) throw new ToolFailure('missing required argument: repo');
  if (owner && forge.viewerLogin !== null && owner !== forge.viewerLogin) throw new ToolFailure(`repository ${owner}/${name} not found`);
  const repo = forge.getRepo(name);
  if (!repo) throw new ToolFailure(`repository ${name} not found`);
  if (owner && forge.viewerLogin === null) forge.viewerLogin = owner;
  return repo;
}

function requireArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new ToolFailure(`missing required argument: ${key}`);
  return value;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = requireArg(args, 'name');
      if (forge.getRepo(repoName)) throw new ToolFailure(`repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : null,
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      return repoResult(repo);
    }
    case 'get_repo': {
      return repoResult(resolveRepo(args));
    }
    case 'create_issue': {
      const repo = resolveRepo(args);
      const title = requireArg(args, 'title');
      const now = clock.iso();
      const issue: Issue = {
        id: forge.globalId(), number: repo.nextNumber++, title,
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open', labels: [], isPull: false, createdAt: now, updatedAt: now, comments: [],
      };
      repo.issues.set(issue.number, issue);
      return issueResult(repo, issue);
    }
    case 'list_issues': {
      const repo = resolveRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return { issues: list.map((i) => issueResult(repo, i)), total_count: list.length };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(args);
      const title = requireArg(args, 'title');
      const headRef = requireArg(args, 'head').split(':').pop() as string;
      const baseRef = requireArg(args, 'base').split(':').pop() as string;
      const headSha = repo.branchTip(headRef);
      const baseSha = repo.branchTip(baseRef);
      if (!headSha || !baseSha) throw new ToolFailure('head or base branch not found');
      const now = clock.iso();
      const pull: Pull = {
        id: forge.globalId(), number: repo.nextNumber++, title,
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open', headRef, headSha, baseRef, baseSha, merged: false, mergedAt: null,
        mergeCommitSha: null, createdAt: now, updatedAt: now, isPull: true,
      };
      repo.pulls.set(pull.number, pull);
      return pullResult(repo, pull);
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) throw new ToolFailure(`pull request ${String(args.pull_number)} not found`);
      if (pull.merged) return { ...pullResult(repo, pull), sha: pull.mergeCommitSha, message: 'Pull Request successfully merged' };
      pull.headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
      const result = mergePull(repo, pull, 'squash');
      if (result === 'conflict') throw new ToolFailure('pull request has merge conflicts');
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = clock.iso();
      pull.updatedAt = pull.mergedAt;
      pull.mergeCommitSha = result;
      return { ...pullResult(repo, pull), sha: result, message: 'Pull Request successfully merged' };
    }
    default:
      throw new ToolFailure(`unknown tool: ${name}`);
  }
}

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown> | null; // null = no body (notification accepted)
}

function handleRpc(request: Record<string, unknown>): RpcOutcome {
  const id = (request.id ?? null) as unknown;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;

  const result = (value: unknown): RpcOutcome => ({
    status: 200,
    payload: { jsonrpc: '2.0', id, result: value },
  });
  const error = (code: number, message: string): RpcOutcome => ({
    status: 200,
    payload: { jsonrpc: '2.0', id, error: { code, message } },
  });

  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return result({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return { status: 200, payload: { jsonrpc: '2.0', id, result: JSON.parse(TOOLS_LIST_JSON) as unknown } };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return error(-32602, `unknown tool: ${name}`);
      const required = (tool.inputSchema.required as string[] | undefined) ?? [];
      for (const key of required) {
        if (args[key] === undefined || args[key] === null || args[key] === '') {
          return error(-32602, `missing required argument: ${key}`);
        }
      }
      try {
        const value = callTool(name, args);
        return result({
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (err) {
        if (err instanceof ToolFailure) {
          return result({
            content: [{ type: 'text', text: err.message }],
            isError: true,
          });
        }
        throw err;
      }
    }
    default:
      if (isNotification) return { status: 202, payload: null };
      return error(-32601, `method not found: ${method}`);
  }
}

export function handleMcp(ctx: Ctx, sendJson: SendJson): void {
  const res: ServerResponse = ctx.res;
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET' || method === 'DELETE') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
    return;
  }
  const text = ctx.rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': 'FORGE-MCP' });
    res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    return;
  }
  const requests = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
  const outcomes = requests.map((r) => handleRpc(r));
  const payloads = outcomes.map((o) => o.payload).filter((p) => p !== null);
  if (payloads.length === 0) {
    res.writeHead(202, { 'x-github-request-id': 'FORGE-MCP' });
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? payloads : payloads[0]);
}
