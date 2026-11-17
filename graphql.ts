// GraphQL v4: a small parser and executor over the forge store, covering the documents
// gh and github-mcp-server send: viewer, repository reads, issue/pull connections with
// cursor pagination, node(id), __type introspection, and the create/close/merge/comment
// mutations. Global ids are stable strings that encode their object, so a node read or a
// mutation input resolves to the same store object a REST read sees.

import type { ServerResponse } from 'node:http';
import { forge, clock, type Repo, type Issue, type Pull } from './store.ts';
import { pullFiles, pullConflicts, mergePull } from './merge.ts';
import type { Ctx, SendJson } from './app.ts';

// --------------------------------------------------------------------------- ids

const repoGid = (repo: Repo): string => `repo:${repo.id}`;
const issueGid = (repo: Repo, issue: Issue): string => `issue:${repo.id}:${issue.number}`;
const pullGid = (repo: Repo, pull: Pull): string => `pr:${repo.id}:${pull.number}`;
const commentGid = (id: number): string => `comment:${id}`;
const userGid = (login: string): string => `user:${login}`;

function repoByGid(gid: string): Repo | null {
  const m = /^repo:(\d+)$/.exec(gid);
  if (!m) return null;
  const id = Number(m[1]);
  return forge.listRepos().find((r) => r.id === id) ?? null;
}
function issueByGid(gid: string): { repo: Repo; issue: Issue } | null {
  const m = /^issue:(\d+):(\d+)$/.exec(gid);
  if (!m) return null;
  const repo = forge.listRepos().find((r) => r.id === Number(m[1]));
  const issue = repo?.issues.get(Number(m[2]));
  return repo && issue ? { repo, issue } : null;
}
function pullByGid(gid: string): { repo: Repo; pull: Pull } | null {
  const m = /^pr:(\d+):(\d+)$/.exec(gid);
  if (!m) return null;
  const repo = forge.listRepos().find((r) => r.id === Number(m[1]));
  const pull = repo?.pulls.get(Number(m[2]));
  return repo && pull ? { repo, pull } : null;
}

function viewerLogin(): string {
  return forge.viewerLogin ?? 'viewer';
}

// --------------------------------------------------------------------------- parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class ParseError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:$=!@'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end === -1 ? source.length : end)}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) { text += source[j + 1]; j += 2; }
        else { text += source[j]; j += 1; }
      }
      tokens.push(`"${text}"`);
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z0-9_.-]+/.exec(source.slice(i));
    if (m) { tokens.push(m[0]); i += m[0].length; continue; }
    i += 1;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;
  fragments = new Map<string, { typeCondition: string | null; selection: SelectionNode[] }>();
  constructor(source: string) {
    this.tokens = tokenize(source);
  }
  private peek(): string | undefined { return this.tokens[this.pos]; }
  private next(): string {
    const t = this.tokens[this.pos++];
    if (t === undefined) throw new ParseError('unexpected end of document');
    return t;
  }
  private expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new ParseError(`expected ${t}, got ${got}`);
  }
  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t === open) depth += 1;
      else if (t === close) depth -= 1;
    } while (depth > 0);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t === 'query' || t === 'mutation' || t === 'subscription') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (t === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        const selection = this.parseSelectionSet();
        this.fragments.set(fragName, { typeCondition, selection });
      } else if (t === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else {
        throw new ParseError(`unexpected token ${t}`);
      }
    }
    return operations;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const nodes: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          nodes.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          nodes.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Record<string, Value> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.expect(')');
      }
      if (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
      }
      const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
      nodes.push({ kind: 'field', alias, name, args, selection });
    }
    this.expect('}');
    return nodes;
  }

  private parseValue(): Value {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t.startsWith('"')) return { kind: 'string', value: t.slice(1, -1) };
    if (t === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t === 'true' || t === 'false') return { kind: 'bool', value: t === 'true' };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?\d+\.\d+$/.test(t)) return { kind: 'float', value: Number(t) };
    return { kind: 'enum', value: t };
  }
}

function resolveValue(value: Value, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': return vars[value.name] ?? null;
    case 'string': return value.value;
    case 'int': case 'float': return value.value;
    case 'bool': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.fields)) out[k] = resolveValue(v, vars);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema

interface GqlObject { __typename: string; [key: string]: unknown }
type Resolver = (parent: GqlObject, args: Record<string, unknown>) => unknown;

const userObject = (login: string): GqlObject => ({ __typename: 'User', id: userGid(login), login });

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', _repo: repo, id: repoGid(repo), databaseId: repo.id, name: repo.name };
}
function issueObject(repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: 'Issue', _repo: repo, _issue: issue, id: issueGid(repo, issue),
    number: issue.number, title: issue.title, body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt, updatedAt: issue.updatedAt,
  };
}
function pullObject(repo: Repo, pull: Pull): GqlObject {
  return {
    __typename: 'PullRequest', _repo: repo, _pull: pull, id: pullGid(repo, pull),
    number: pull.number, title: pull.title, body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged, mergedAt: pull.mergedAt,
    headRefName: pull.headRef, baseRefName: pull.baseRef,
    createdAt: pull.createdAt, updatedAt: pull.updatedAt,
  };
}

function pageInfo(items: unknown[], first: number | null, afterIdx: number): GqlObject {
  const total = items.length;
  const end = first === null ? total : Math.min(total, afterIdx + first);
  return {
    __typename: 'PageInfo',
    hasNextPage: end < total,
    hasPreviousPage: afterIdx > 0,
    endCursor: end > afterIdx ? `cursor:${end}` : null,
    startCursor: items.length > 0 ? `cursor:${afterIdx + 1}` : null,
  };
}

function connection(type: string, all: GqlObject[], args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? args.first : null;
  let afterIdx = 0;
  if (typeof args.after === 'string') {
    const m = /^cursor:(\d+)$/.exec(args.after);
    if (m) afterIdx = Number(m[1]);
  }
  const window = first === null ? all.slice(afterIdx) : all.slice(afterIdx, afterIdx + first);
  return { __typename: type, nodes: window, totalCount: all.length, pageInfo: pageInfo(all, first, afterIdx) };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'author', 'repository', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'files', 'commits', 'additions', 'deletions', 'changedFiles', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'url'],
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

const FIELDS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObject(viewerLogin()),
    repository: (_p, args) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (forge.viewerLogin !== null && owner !== forge.viewerLogin) return null;
      const repo = forge.getRepo(name);
      if (!repo) return null;
      if (forge.viewerLogin === null) forge.viewerLogin = owner;
      return repoObject(repo);
    },
    node: (_p, args) => {
      const id = String(args.id ?? '');
      if (id.startsWith('repo:')) {
        const repo = repoByGid(id);
        return repo ? repoObject(repo) : null;
      }
      if (id.startsWith('issue:')) {
        const found = issueByGid(id);
        return found ? issueObject(found.repo, found.issue) : null;
      }
      if (id.startsWith('pr:')) {
        const found = pullByGid(id);
        return found ? pullObject(found.repo, found.pull) : null;
      }
      if (id.startsWith('user:')) return userObject(id.slice(5));
      return null;
    },
    __type: (_p, args) => typeObject(String(args.name ?? '')),
  },
  User: {
    login: (p) => p.login,
    id: (p) => p.id,
    name: (p) => p.login,
  },
  Repository: {
    id: (p) => p.id,
    databaseId: (p) => p.databaseId,
    name: (p) => p.name,
    nameWithOwner: (p) => `${viewerLogin()}/${(p._repo as Repo).name}`,
    owner: () => userObject(viewerLogin()),
    description: (p) => (p._repo as Repo).description,
    isPrivate: (p) => (p._repo as Repo).isPrivate,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (p) => (p._repo as Repo).createdAt,
    updatedAt: (p) => (p._repo as Repo).updatedAt,
    defaultBranchRef: (p) => {
      const repo = p._repo as Repo;
      if (!repo.branchTip(repo.defaultBranch)) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' } as GqlObject;
    },
    issue: (p, args) => {
      const repo = p._repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueObject(repo, issue) : null;
    },
    issues: (p, args) => {
      const repo = p._repo as Repo;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const direction = orderBy?.direction ?? 'DESC';
      list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      return connection('IssueConnection', list.map((i) => issueObject(repo, i)), args);
    },
    pullRequest: (p, args) => {
      const repo = p._repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullObject(repo, pull) : null;
    },
    pullRequests: (p, args) => {
      const repo = p._repo as Repo;
      let list = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states) {
        list = list.filter((pl) => states.includes(pl.merged ? 'MERGED' : pl.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      list.sort((a, b) => b.number - a.number);
      return connection('PullRequestConnection', list.map((pl) => pullObject(repo, pl)), args);
    },
  },
  Issue: {
    id: (p) => p.id,
    number: (p) => p.number,
    title: (p) => p.title,
    state: (p) => p.state,
    body: (p) => p.body,
    createdAt: (p) => p.createdAt,
    updatedAt: (p) => p.updatedAt,
    closedAt: (p) => (p.state === 'CLOSED' ? p.updatedAt : null),
    author: () => userObject(viewerLogin()),
    repository: (p) => repoObject(p._repo as Repo),
  },
  PullRequest: {
    id: (p) => p.id,
    number: (p) => p.number,
    title: (p) => p.title,
    state: (p) => p.state,
    body: (p) => p.body,
    merged: (p) => p.merged,
    mergedAt: (p) => p.mergedAt,
    headRefName: (p) => p.headRefName,
    baseRefName: (p) => p.baseRefName,
    createdAt: (p) => p.createdAt,
    updatedAt: (p) => p.updatedAt,
    author: () => userObject(viewerLogin()),
    repository: (p) => repoObject(p._repo as Repo),
    mergeable: (p) => {
      const pull = p._pull as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullConflicts(p._repo as Repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (p, args) => {
      const repo = p._repo as Repo;
      const pull = p._pull as Pull;
      pull.headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
      const files = pullFiles(repo, pull).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions } as GqlObject));
      return connection('PullRequestChangedFileConnection', files, args);
    },
  },
  Ref: {
    name: (p) => p.name,
    prefix: (p) => p.prefix,
  },
  PageInfo: {
    hasNextPage: (p) => p.hasNextPage,
    hasPreviousPage: (p) => p.hasPreviousPage,
    endCursor: (p) => p.endCursor,
    startCursor: (p) => p.startCursor,
  },
  IssueConnection: { nodes: (p) => p.nodes, totalCount: (p) => p.totalCount, pageInfo: (p) => p.pageInfo },
  PullRequestConnection: { nodes: (p) => p.nodes, totalCount: (p) => p.totalCount, pageInfo: (p) => p.pageInfo },
  PullRequestChangedFileConnection: { nodes: (p) => p.nodes, totalCount: (p) => p.totalCount, pageInfo: (p) => p.pageInfo },
  PullRequestChangedFile: { path: (p) => p.path, additions: (p) => p.additions, deletions: (p) => p.deletions },
  __Type: {
    name: (p) => p.name,
    kind: (p) => p.kind,
    fields: (p) => p._fields ?? null,
    enumValues: (p) => p._enums ?? null,
  },
  __Field: { name: (p) => p.name },
  __EnumValue: { name: (p) => p.name },
  Mutation: {
    createIssue: (_p, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGid(String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repository not found');
      const now = clock.iso();
      const issue: Issue = {
        id: forge.globalId(), number: repo.nextNumber++, title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : null,
        state: 'open', labels: [], isPull: false, createdAt: now, updatedAt: now, comments: [],
      };
      repo.issues.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null } as GqlObject;
    },
    closeIssue: (_p, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGid(String(input.issueId ?? ''));
      if (!found) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.updatedAt = clock.iso();
      return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null } as GqlObject;
    },
    createPullRequest: (_p, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGid(String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? repo.defaultBranch);
      const headSha = repo.branchTip(headRef);
      const baseSha = repo.branchTip(baseRef);
      if (!headSha || !baseSha) throw new Error('head or base branch not found');
      const now = clock.iso();
      const pull: Pull = {
        id: forge.globalId(), number: repo.nextNumber++, title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : null,
        state: 'open', headRef, headSha, baseRef, baseSha, merged: false, mergedAt: null,
        mergeCommitSha: null, createdAt: now, updatedAt: now, isPull: true,
      };
      repo.pulls.set(pull.number, pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null } as GqlObject;
    },
    mergePullRequest: (_p, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGid(String(input.pullRequestId ?? ''));
      if (!found) throw new Error('pull request not found');
      const { repo, pull } = found;
      if (!pull.merged && pull.state === 'open') {
        pull.headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
        const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
        const result = mergePull(repo, pull, method === 'merge' ? 'merge' : 'squash');
        if (result === 'conflict') throw new Error('pull request has merge conflicts');
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = clock.iso();
        pull.updatedAt = pull.mergedAt;
        pull.mergeCommitSha = result;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null } as GqlObject;
    },
    addComment: (_p, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGid(String(input.subjectId ?? ''));
      if (!found) throw new Error('subject not found');
      const now = clock.iso();
      const comment = { id: forge.globalId(), body: String(input.body ?? ''), createdAt: now, updatedAt: now };
      found.issue.comments.push(comment);
      const node = { __typename: 'IssueComment', id: commentGid(comment.id), body: comment.body, createdAt: now } as GqlObject;
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: `cursor:${comment.id}` }, clientMutationId: input.clientMutationId ?? null } as unknown as GqlObject;
    },
  },
  CreateIssuePayload: { issue: (p) => p.issue, clientMutationId: (p) => p.clientMutationId },
  CloseIssuePayload: { issue: (p) => p.issue, clientMutationId: (p) => p.clientMutationId },
  CreatePullRequestPayload: { pullRequest: (p) => p.pullRequest, clientMutationId: (p) => p.clientMutationId },
  MergePullRequestPayload: { pullRequest: (p) => p.pullRequest, clientMutationId: (p) => p.clientMutationId },
  AddCommentPayload: { commentEdge: (p) => p.commentEdge, clientMutationId: (p) => p.clientMutationId },
  IssueCommentEdge: { node: (p) => p.node, cursor: (p) => p.cursor },
  IssueComment: { id: (p) => p.id, body: (p) => p.body, createdAt: (p) => p.createdAt, author: () => userObject(viewerLogin()) },
};

function typeObject(name: string): GqlObject | null {
  if (TYPE_FIELDS[name]) {
    return {
      __typename: '__Type', name, kind: 'OBJECT',
      _fields: TYPE_FIELDS[name].map((f) => ({ __typename: '__Field', name: f })),
      _enums: null,
    } as GqlObject;
  }
  if (TYPE_ENUMS[name]) {
    return {
      __typename: '__Type', name, kind: 'ENUM',
      _fields: null,
      _enums: TYPE_ENUMS[name].map((e) => ({ __typename: '__EnumValue', name: e })),
    } as GqlObject;
  }
  return null;
}

// --------------------------------------------------------------------------- executor

interface ExecCtx {
  vars: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

function executeSelection(obj: GqlObject | null, selection: SelectionNode[], ctx: ExecCtx): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  const typeName = obj.__typename;
  for (const node of selection) {
    if (node.kind === 'inline') {
      if (node.typeCondition === null || node.typeCondition === typeName) {
        Object.assign(out, executeSelection(obj, node.selection, ctx));
      }
      continue;
    }
    if (node.kind === 'spread') {
      const frag = ctx.fragments.get(node.name);
      if (frag && (frag.typeCondition === null || frag.typeCondition === typeName)) {
        Object.assign(out, executeSelection(obj, frag.selection, ctx));
      }
      continue;
    }
    const key = node.alias ?? node.name;
    const resolver = FIELDS[typeName]?.[node.name];
    if (!resolver) {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.args)) args[k] = resolveValue(v, ctx.vars);
    let value: unknown;
    try {
      value = resolver(obj, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, node.selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, selection: SelectionNode[] | null, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selection, ctx));
  if (typeof value === 'object') {
    if (!selection) return value;
    return executeSelection(value as GqlObject, selection, ctx);
  }
  return value;
}

function executeOperation(op: Operation, vars: Record<string, unknown>, fragments: ExecCtx['fragments']): Record<string, unknown> {
  const ctx: ExecCtx = { vars, fragments, errors: [] };
  const root: GqlObject = { __typename: op.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(root, op.selection, ctx);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export function handleGraphQL(ctx: Ctx, sendJson: SendJson): void {
  const res: ServerResponse = ctx.res;
  if ((ctx.req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const raw = ctx.rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const isBatch = Array.isArray(parsed);
  const operations = (isBatch ? parsed : [parsed]) as Array<Record<string, unknown>>;
  const results: unknown[] = [];
  for (const entry of operations) {
    const query = typeof entry.query === 'string' ? entry.query : '';
    const vars = (entry.variables && typeof entry.variables === 'object' ? entry.variables : {}) as Record<string, unknown>;
    const opName = typeof entry.operationName === 'string' ? entry.operationName : null;
    try {
      const parser = new Parser(query);
      const ops = parser.parseDocument();
      const op = ops.find((o) => opName === null || o.name === opName) ?? ops[0];
      if (!op) {
        results.push({ data: null, errors: [{ message: 'No operation found' }] });
        continue;
      }
      results.push(executeOperation(op, vars, parser.fragments));
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    }
  }
  sendJson(res, 200, isBatch ? results : results[0]);
}
