// REST v3: repositories, contents, branches, commits, labels, issues,
// comments and pull requests, in GitHub's shapes and status codes.
//
// The contract the suite checks, honoured exactly: every reply is JSON with
// a `message` string on errors; an unauthenticated call is a 401; a
// repository under a foreign owner is a 404, never a 403; list endpoints
// paginate with `Link: <absolute same-origin URL>; rel="next"`.

import type { Ctx } from './app.ts';
import { sendJson, sendError } from './app.ts';
import { Forge, Repo, type IssueRec, type PullRec } from './store.ts';
import { VIEWER } from './viewer.ts';
import * as ids from './ids.ts';
import { parseCommit, parseTree } from './gitobjects.ts';

// ---------------------------------------------------------------- helpers

function segments(ctx: Ctx): string[] {
  return ctx.path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

interface BodyResult {
  value: Record<string, unknown>;
  error: string | null;
}

/** Parse a JSON request body; an empty body is {}, malformed JSON an error. */
function jsonBody(ctx: Ctx): BodyResult {
  const text = ctx.body.toString('utf8').trim();
  if (text === '') return { value: {}, error: null };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { value: {}, error: 'request body must be a JSON object' };
    return { value: parsed as Record<string, unknown>, error: null };
  } catch {
    return { value: {}, error: 'Problems parsing JSON' };
  }
}

function origin(ctx: Ctx): string {
  return `http://${ctx.req.headers.host ?? 'localhost'}`;
}

interface Page {
  items: unknown[];
  link: string | null;
}

/** Slice a list by page/per_page and build the GitHub Link header. */
function paginate(ctx: Ctx, all: unknown[], basePath: string): Page {
  const perPageRaw = Number(ctx.url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(ctx.url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const urlFor = (p: number): string => {
    const url = new URL(`${origin(ctx)}${basePath}`);
    for (const [key, value] of ctx.url.searchParams) if (key !== 'page') url.searchParams.set(key, value);
    url.searchParams.set('page', String(p));
    if (!url.searchParams.has('per_page')) url.searchParams.set('per_page', String(perPage));
    return url.toString();
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`, `<${urlFor(1)}>; rel="first"`);
  return { items, link: links.length === 0 ? null : links.join(', ') };
}

function sendPage(ctx: Ctx, page: Page): void {
  sendJson(ctx, 200, page.items, page.link === null ? {} : { link: page.link });
}

// ---------------------------------------------------------------- serializers

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, node_id: ids.userId(VIEWER.id), type: 'User', name: VIEWER.name, email: VIEWER.email };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: ids.repositoryId(repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_pull_requests: true,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: label?.description ?? null, default: false };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.restId,
    node_id: ids.issueId(repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function refJson(repo: Repo, refName: string, branch: string): Record<string, unknown> {
  return {
    label: `${repo.owner}:${branch}`,
    ref: branch,
    sha: repo.branchTip(branch),
    user: userJson(),
    repo: repoJson(repo),
  };
}

export function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.restId,
    node_id: ids.pullRequestId(repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    head: refJson(repo, `refs/heads/${pull.headRef}`, pull.headRef),
    base: refJson(repo, `refs/heads/${pull.baseRef}`, pull.baseRef),
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commentJson(repo: Repo, issue: IssueRec, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  void repo;
  void issue;
  return { id: comment.id, body: comment.body, user: userJson(), created_at: comment.createdAt, updated_at: comment.createdAt };
}

function identityParts(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(forge: Forge, oid: string): Record<string, unknown> | null {
  const object = forge.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const info = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      message: info.message.replace(/\n$/, ''),
      author: identityParts(info.author),
      committer: identityParts(info.committer),
      tree: { sha: info.tree },
    },
    author: userJson(),
    committer: userJson(),
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------- shared route pieces

/** Resolve the repository of a /repos/{owner}/{repo} route, answering 404. */
function requireRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** The labels a body names, validated against the repository's label set. */
function validLabels(ctx: Ctx, repo: Repo, body: Record<string, unknown>): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    sendError(ctx, 422, 'Validation Failed: labels must be an array');
    return null;
  }
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' ? ((entry as { name: string }).name as string) : null;
    if (name === null) {
      sendError(ctx, 422, 'Validation Failed: labels must be names');
      return null;
    }
    if (!repo.labels.has(name)) {
      sendError(ctx, 422, `Validation Failed: label '${name}' does not exist`);
      return null;
    }
    names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------- the router

export async function handleRest(ctx: Ctx): Promise<void> {
  const parts = segments(ctx).slice(2); // drop 'api', 'v3'
  const method = ctx.method;

  // The API root and meta are public, as on GitHub.
  if (parts.length === 0) {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    return sendJson(
      ctx,
      200,
      {
        current_user_url: `${origin(ctx)}/api/v3/user`,
        repository_url: `${origin(ctx)}/api/v3/repos/{owner}/{repo}`,
        issue_search_url: `${origin(ctx)}/api/v3/search/issues?q={query}`,
        rate_limit_url: `${origin(ctx)}/api/v3/rate_limit`,
      },
      { 'x-oauth-scopes': 'repo, read:org, write:org' },
    );
  }
  if (parts.length === 1 && parts[0] === 'meta') {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
  }

  // Everything else needs the token.
  if (!ctx.authed) return sendError(ctx, 401, 'Bad credentials');

  if (parts[0] === 'user' && parts.length === 1) {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, userJson());
  }
  if (parts[0] === 'user' && parts.length === 2 && parts[1] === 'repos') {
    if (method === 'GET') {
      const all = ctx.forge.viewerRepos().map(repoJson);
      return sendPage(ctx, paginate(ctx, all, '/api/v3/user/repos'));
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body.error !== null) return sendError(ctx, 400, body.error);
      const name = typeof body.value.name === 'string' ? body.value.name : '';
      if (name === '' || /[^A-Za-z0-9._-]/.test(name)) return sendError(ctx, 422, 'Validation Failed: name is invalid');
      const repo = ctx.forge.createRepo(name, {
        description: typeof body.value.description === 'string' ? body.value.description : '',
        isPrivate: body.value.private === true,
      });
      if (repo === null) return sendError(ctx, 422, 'Validation Failed: name already exists on this account');
      return sendJson(ctx, 201, repoJson(repo));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  if (parts[0] !== 'repos' || parts.length < 3) return sendError(ctx, 404, 'Not Found');
  const owner = parts[1] as string;
  const repoName = parts[2] as string;
  const repo = requireRepo(ctx, owner, repoName);
  if (repo === null) return;
  const rest = parts.slice(3);
  const forge = ctx.forge;

  // /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') return sendJson(ctx, 200, repoJson(repo));
    if (method === 'PATCH') {
      const body = jsonBody(ctx);
      if (body.error !== null) return sendError(ctx, 400, body.error);
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      if (typeof body.value.private === 'boolean') repo.isPrivate = body.value.private;
      if (typeof body.value.default_branch === 'string' && body.value.default_branch !== '') {
        const candidate = body.value.default_branch;
        if (repo.refs.size > 0 && repo.branchTip(candidate) === null) return sendError(ctx, 422, 'Validation Failed: default branch does not exist');
        repo.defaultBranch = candidate;
      }
      repo.updatedAt = forge.nowIso();
      return sendJson(ctx, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
      ctx.res.end();
      return;
    }
    return sendError(ctx, 404, 'Not Found');
  }

  if (rest[0] === 'contents') return contentsRoute(ctx, repo, rest.slice(1).join('/'));
  if (rest[0] === 'branches') return branchesRoute(ctx, repo, rest.slice(1).join('/'));
  if (rest[0] === 'commits') return commitsRoute(ctx, repo, rest.slice(1));
  if (rest[0] === 'git') return gitDataRoute(ctx, repo, rest.slice(1));
  if (rest[0] === 'labels') return labelsRoute(ctx, repo, rest.slice(1));
  if (rest[0] === 'issues') return issuesRoute(ctx, repo, rest.slice(1));
  if (rest[0] === 'pulls') return pullsRoute(ctx, repo, rest.slice(1));
  return sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function contentsRoute(ctx: Ctx, repo: Repo, path: string): void {
  const forge = ctx.forge;
  const method = ctx.method;
  const refParam = ctx.url.searchParams.get('ref');

  if (method === 'GET') {
    let commitOid: string | null;
    if (refParam !== null && /^[0-9a-f]{40}$/.test(refParam) && forge.objects.has(refParam)) commitOid = refParam;
    else commitOid = repo.branchTip(refParam ?? repo.defaultBranch);
    if (commitOid === null) {
      // An empty repository reads as an empty root listing, a 404 elsewhere.
      if (path === '') return sendJson(ctx, 200, []);
      return sendError(ctx, 404, 'Not Found');
    }
    const flat = forge.treeFiles(commitOid);
    if (path !== '' && flat.has(path)) {
      const file = flat.get(path) as { mode: string; oid: string };
      const blob = forge.objects.get(file.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      const name = path.split('/').pop() as string;
      return sendJson(ctx, 200, {
        type: 'file',
        name,
        path,
        sha: file.oid,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      });
    }
    // A directory listing: immediate children of `path`.
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
    let isDir = path === '';
    for (const [filePath, file] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      isDir = true;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) children.set(rest, { type: 'file', oid: file.oid, size: forge.objects.get(file.oid)?.data.length ?? 0 });
      else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) children.set(dirName, { type: 'dir', oid: '', size: 0 });
      }
    }
    if (!isDir) return sendError(ctx, 404, 'Not Found');
    const entries = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, child]) => ({
        type: child.type,
        name,
        path: `${prefix}${name}`,
        sha: child.type === 'file' ? child.oid : dirSha(forge, commitOid, `${prefix}${name}`),
        ...(child.type === 'file' ? { size: child.size } : {}),
      }));
    return sendJson(ctx, 200, entries);
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = jsonBody(ctx);
    if (body.error !== null) return sendError(ctx, 400, body.error);
    if (path === '') return sendError(ctx, 422, 'Validation Failed: path is required');
    const branch = typeof body.value.branch === 'string' && body.value.branch !== '' ? body.value.branch : repo.defaultBranch;
    const message = typeof body.value.message === 'string' && body.value.message !== '' ? body.value.message : method === 'PUT' ? `Update ${path}` : `Delete ${path}`;
    const flat = forge.branchFiles(repo, branch);
    const existing = flat.get(path);
    if (method === 'PUT') {
      if (typeof body.value.content !== 'string') return sendError(ctx, 422, 'Validation Failed: content is required');
      const content = Buffer.from(body.value.content.replace(/[\r\n\t ]+/g, ''), 'base64');
      if (existing !== undefined) {
        if (body.value.sha === undefined) return sendError(ctx, 422, `Validation Failed: "sha" wasn't supplied`);
        if (body.value.sha !== existing.oid) return sendError(ctx, 409, `${path} has changed since it was read`);
      }
      const result = forge.writeFile(repo, branch, path, content, message);
      const name = path.split('/').pop() as string;
      return sendJson(ctx, result.created ? 201 : 200, {
        content: { type: 'file', name, path, sha: result.blobOid, size: content.length, encoding: 'base64' },
        commit: { sha: result.commitOid, message },
      });
    }
    // DELETE
    if (existing === undefined) return sendError(ctx, 404, 'Not Found');
    if (body.value.sha !== undefined && body.value.sha !== existing.oid) return sendError(ctx, 409, `${path} has changed since it was read`);
    const commitOid = forge.deleteFile(repo, branch, path, message);
    return sendJson(ctx, 200, { content: null, commit: { sha: commitOid, message } });
  }

  return sendError(ctx, 404, 'Not Found');
}

/** The tree id of a directory inside a commit (for directory listings). */
function dirSha(forge: Forge, commitOid: string, dirPath: string): string {
  const treeOid = forge.commitTree(commitOid);
  if (treeOid === null) return '';
  let current = treeOid;
  for (const segment of dirPath.split('/').filter((part) => part !== '')) {
    const tree = forge.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return '';
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return '';
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------- branches & commits

function branchesRoute(ctx: Ctx, repo: Repo, name: string): void {
  if (ctx.method !== 'GET') return sendError(ctx, 404, 'Not Found');
  if (name === '') {
    const all = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return sendPage(ctx, paginate(ctx, all, `/api/v3/repos/${repo.owner}/${repo.name}/branches`));
  }
  const sha = repo.branchTip(name);
  if (sha === null) return sendError(ctx, 404, 'Not Found');
  return sendJson(ctx, 200, { name, commit: { sha }, protected: false });
}

function commitsRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  if (ctx.method !== 'GET') return sendError(ctx, 404, 'Not Found');
  const forge = ctx.forge;
  if (rest.length === 1 && /^[0-9a-f]{40}$/.test(rest[0] as string)) {
    const one = commitJson(forge, rest[0] as string);
    if (one === null) return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, one);
  }
  if (rest.length > 0) return sendError(ctx, 404, 'Not Found');
  const shaQuery = ctx.url.searchParams.get('sha');
  let tip: string | null = null;
  if (shaQuery !== null && /^[0-9a-f]{40}$/.test(shaQuery)) tip = shaQuery;
  else if (shaQuery !== null && shaQuery !== '') tip = repo.branchTip(shaQuery) ?? repo.refs.get(shaQuery) ?? null;
  else tip = repo.branchTip(repo.defaultBranch);
  if (tip === null) return sendError(ctx, 409, 'Git Repository is empty.');
  const all = forge
    .listCommits(tip)
    .map((oid) => commitJson(forge, oid))
    .filter((entry) => entry !== null);
  return sendPage(ctx, paginate(ctx, all, `/api/v3/repos/${repo.owner}/${repo.name}/commits`));
}

// ---------------------------------------------------------------- git data (refs)

function gitDataRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const forge = ctx.forge;
  if (rest[0] !== 'refs') return sendError(ctx, 404, 'Not Found');
  if (rest.length === 1) {
    if (ctx.method === 'POST') {
      const body = jsonBody(ctx);
      if (body.error !== null) return sendError(ctx, 400, body.error);
      const ref = typeof body.value.ref === 'string' ? body.value.ref : '';
      const sha = typeof body.value.sha === 'string' ? body.value.sha : '';
      if (!ref.startsWith('refs/')) return sendError(ctx, 422, 'Validation Failed: ref must start with refs/');
      const object = forge.objects.get(sha);
      if (object === undefined) return sendError(ctx, 422, `Validation Failed: object ${sha} does not exist`);
      if (ref.startsWith('refs/heads/') && object.type !== 'commit') return sendError(ctx, 422, 'Validation Failed: a branch must point at a commit');
      if (repo.refs.has(ref)) return sendError(ctx, 422, 'Validation Failed: Reference already exists');
      repo.refs.set(ref, sha);
      repo.updatedAt = forge.nowIso();
      return sendJson(ctx, 201, { ref, object: { sha, type: object.type } });
    }
    if (ctx.method === 'GET') {
      const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: forge.objects.get(sha)?.type ?? 'commit' } }));
      return sendJson(ctx, 200, all);
    }
    return sendError(ctx, 404, 'Not Found');
  }
  // GET /git/refs/{ref...}: the suite asks for heads/{branch}.
  const tail = rest.slice(1).join('/');
  const full = tail.startsWith('refs/') ? tail : `refs/${tail}`;
  if (ctx.method === 'GET') {
    const sha = repo.refs.get(full);
    if (sha === undefined) return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, { ref: full, object: { sha, type: forge.objects.get(sha)?.type ?? 'commit' } });
  }
  if (ctx.method === 'DELETE') {
    if (!repo.refs.delete(full)) return sendError(ctx, 404, 'Not Found');
    ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  return sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- labels

function labelsRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const forge = ctx.forge;
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const all = [...repo.labels.values()].map((label) => labelJson(repo, label.name));
      return sendPage(ctx, paginate(ctx, all, `/api/v3/repos/${repo.owner}/${repo.name}/labels`));
    }
    if (ctx.method === 'POST') {
      const body = jsonBody(ctx);
      if (body.error !== null) return sendError(ctx, 400, body.error);
      const name = typeof body.value.name === 'string' ? body.value.name : '';
      if (name === '') return sendError(ctx, 422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return sendError(ctx, 422, 'Validation Failed: name already exists');
      const color = typeof body.value.color === 'string' ? body.value.color.replace(/^#/, '') : 'ededed';
      repo.labels.set(name, { name, color, description: typeof body.value.description === 'string' ? body.value.description : null });
      repo.updatedAt = forge.nowIso();
      return sendJson(ctx, 201, labelJson(repo, name));
    }
    return sendError(ctx, 404, 'Not Found');
  }
  const name = rest.join('/');
  if (ctx.method === 'GET') {
    if (!repo.labels.has(name)) return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, labelJson(repo, name));
  }
  if (ctx.method === 'DELETE') {
    if (!repo.labels.delete(name)) return sendError(ctx, 404, 'Not Found');
    ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  return sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function issuesRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const forge = ctx.forge;
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      const labelFilter = (ctx.url.searchParams.get('labels') ?? '').split(',').filter((name) => name !== '');
      let all = [...repo.issues.values()];
      if (state === 'open') all = all.filter((issue) => issue.state === 'open');
      else if (state === 'closed') all = all.filter((issue) => issue.state === 'closed');
      if (labelFilter.length > 0) all = all.filter((issue) => labelFilter.every((name) => issue.labels.includes(name)));
      all.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return sendPage(ctx, paginate(ctx, all.map((issue) => issueJson(repo, issue)), `/api/v3/repos/${repo.owner}/${repo.name}/issues`));
    }
    if (ctx.method === 'POST') {
      const body = jsonBody(ctx);
      if (body.error !== null) return sendError(ctx, 400, body.error);
      const title = typeof body.value.title === 'string' ? body.value.title : '';
      if (title === '') return sendError(ctx, 422, 'Validation Failed: title is required');
      const labels = validLabels(ctx, repo, body.value);
      if (labels === null) return;
      const stamp = forge.nowIso();
      const issue: IssueRec = {
        number: repo.nextNumber,
        restId: forge.nextRestId(),
        title,
        body: typeof body.value.body === 'string' ? body.value.body : '',
        state: 'open',
        labels,
        comments: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      repo.updatedAt = stamp;
      return sendJson(ctx, 201, issueJson(repo, issue));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return sendError(ctx, 404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return sendError(ctx, 404, 'Not Found');

  if (rest.length === 1) {
    if (ctx.method === 'GET') return sendJson(ctx, 200, issueJson(repo, issue));
    if (ctx.method === 'PATCH') {
      const body = jsonBody(ctx);
      if (body.error !== null) return sendError(ctx, 400, body.error);
      if (typeof body.value.title === 'string' && body.value.title !== '') issue.title = body.value.title;
      if (typeof body.value.body === 'string') issue.body = body.value.body;
      if (body.value.state !== undefined) {
        if (body.value.state !== 'open' && body.value.state !== 'closed') return sendError(ctx, 422, 'Validation Failed: state must be open or closed');
        issue.state = body.value.state;
      }
      if (body.value.labels !== undefined) {
        const labels = validLabels(ctx, repo, body.value);
        if (labels === null) return;
        issue.labels = labels;
      }
      issue.updatedAt = forge.nowIso();
      return sendJson(ctx, 200, issueJson(repo, issue));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (ctx.method === 'GET') {
      const all = issue.comments.map((comment) => commentJson(repo, issue, comment));
      return sendPage(ctx, paginate(ctx, all, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`));
    }
    if (ctx.method === 'POST') {
      const body = jsonBody(ctx);
      if (body.error !== null) return sendError(ctx, 400, body.error);
      if (typeof body.value.body !== 'string' || body.value.body === '') return sendError(ctx, 422, 'Validation Failed: body is required');
      const comment = { id: forge.nextCommentId(), body: body.value.body, createdAt: forge.nowIso() };
      issue.comments.push(comment);
      issue.updatedAt = comment.createdAt;
      return sendJson(ctx, 201, commentJson(repo, issue, comment));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  return sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- pull requests

function pullsRoute(ctx: Ctx, repo: Repo, rest: string[]): void {
  const forge = ctx.forge;
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let all = [...repo.pulls.values()];
      if (state === 'open') all = all.filter((pull) => pull.state === 'open');
      else if (state === 'closed') all = all.filter((pull) => pull.state === 'closed');
      all.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return sendPage(ctx, paginate(ctx, all.map((pull) => pullJson(repo, pull)), `/api/v3/repos/${repo.owner}/${repo.name}/pulls`));
    }
    if (ctx.method === 'POST') {
      const body = jsonBody(ctx);
      if (body.error !== null) return sendError(ctx, 400, body.error);
      const title = typeof body.value.title === 'string' ? body.value.title : '';
      if (title === '') return sendError(ctx, 422, 'Validation Failed: title is required');
      const headRaw = typeof body.value.head === 'string' ? body.value.head : '';
      const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
      const base = typeof body.value.base === 'string' && body.value.base !== '' ? body.value.base : repo.defaultBranch;
      if (head === '' || repo.branchTip(head) === null) return sendError(ctx, 422, 'Validation Failed: head is invalid');
      if (repo.branchTip(base) === null) return sendError(ctx, 422, 'Validation Failed: base is invalid');
      if (repo.branchTip(head) === repo.branchTip(base)) return sendError(ctx, 422, `Validation Failed: No commits between ${base} and ${head}`);
      const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return sendError(ctx, 422, `Validation Failed: A pull request already exists for ${head} into ${base}`);
      const stamp = forge.nowIso();
      const pull: PullRec = {
        number: repo.nextNumber,
        restId: forge.nextRestId(),
        title,
        body: typeof body.value.body === 'string' ? body.value.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        baseShaAtCreate: repo.branchTip(base),
        createdAt: stamp,
        updatedAt: stamp,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      repo.updatedAt = stamp;
      return sendJson(ctx, 201, pullJson(repo, pull));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return sendError(ctx, 404, 'Not Found');
  const pull = repo.pulls.get(number);

  if (rest.length === 2 && rest[1] === 'merge' && ctx.method === 'PUT') {
    if (pull === undefined) return sendError(ctx, 404, 'Not Found');
    const body = jsonBody(ctx);
    if (body.error !== null) return sendError(ctx, 400, body.error);
    if (pull.merged) return sendError(ctx, 405, 'Pull Request is not mergeable');
    if (pull.state !== 'open') return sendError(ctx, 405, 'Pull Request is not mergeable');
    const sha = forge.mergePull(repo, pull);
    if (sha === null) return sendError(ctx, 405, 'Pull Request has merge conflicts');
    return sendJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  if (pull === undefined) return sendError(ctx, 404, 'Not Found');

  if (rest.length === 1) {
    if (ctx.method === 'GET') return sendJson(ctx, 200, pullJson(repo, pull));
    if (ctx.method === 'PATCH') {
      const body = jsonBody(ctx);
      if (body.error !== null) return sendError(ctx, 400, body.error);
      if (typeof body.value.title === 'string' && body.value.title !== '') pull.title = body.value.title;
      if (typeof body.value.body === 'string') pull.body = body.value.body;
      if (body.value.state !== undefined) {
        if (body.value.state !== 'open' && body.value.state !== 'closed') return sendError(ctx, 422, 'Validation Failed: state must be open or closed');
        if (!pull.merged) pull.state = body.value.state;
      }
      pull.updatedAt = forge.nowIso();
      return sendJson(ctx, 200, pullJson(repo, pull));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'files' && ctx.method === 'GET') {
    const files = forge.prFiles(repo, pull).map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    return sendPage(ctx, paginate(ctx, files, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${number}/files`));
  }

  return sendError(ctx, 404, 'Not Found');
}
