// MCP: the Model Context Protocol endpoint at /mcp, JSON-RPC 2.0 over
// Streamable HTTP, speaking the 2026-07-28 revision (server/discover, no
// handshake, no session) and the legacy initialize handshake before it.
//
// Six tools over the same store as REST: create_repo, get_repo,
// create_issue, list_issues, create_pull_request, merge_pull_request.
// A tool result is the object's JSON as a text block plus structured
// content, so an MCP-created object reads back over REST unchanged.

import type { Ctx } from './app.ts';
import { sendJson } from './app.ts';
import type { Forge, Repo } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function toolSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function needString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new ToolError(`missing required argument: ${key}`);
  return value;
}

function optString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

class ToolError extends Error {}

function requireRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = needString(args, 'owner');
  const name = needString(args, 'repo');
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw new ToolError(`repository ${owner}/${name} not found`);
  return repo;
}

/** The tool table: fixed order, fixed shapes (tools/list is idempotent). */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: toolSchema(
      { name: stringProp('The repository name'), description: stringProp('A short description'), private: { type: 'boolean', description: 'Whether the repository is private' } },
      ['name'],
    ),
    run(forge, args) {
      const name = needString(args, 'name');
      const repo = forge.createRepo(name, {
        description: optString(args, 'description'),
        isPrivate: args.private === true,
      });
      if (repo === null) throw new ToolError(`repository ${name} already exists`);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: toolSchema({ owner: stringProp('The repository owner'), repo: stringProp('The repository name') }, ['owner', 'repo']),
    run(forge, args) {
      return repoJson(requireRepo(forge, args));
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: toolSchema(
      { owner: stringProp('The repository owner'), repo: stringProp('The repository name'), title: stringProp('The issue title'), body: stringProp('The issue body') },
      ['owner', 'repo', 'title'],
    ),
    run(forge, args) {
      const repo = requireRepo(forge, args);
      const issue = forge.createIssue(repo, { title: needString(args, 'title'), body: optString(args, 'body') });
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: toolSchema(
      { owner: stringProp('The repository owner'), repo: stringProp('The repository name'), state: stringProp('Filter by state: open, closed or all') },
      ['owner', 'repo'],
    ),
    run(forge, args) {
      const repo = requireRepo(forge, args);
      const state = optString(args, 'state');
      let all = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open') all = all.filter((issue) => issue.state === 'open');
      else if (state === 'closed') all = all.filter((issue) => issue.state === 'closed');
      return all.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: toolSchema(
      {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The head branch'),
        base: stringProp('The base branch'),
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
    run(forge, args) {
      const repo = requireRepo(forge, args);
      const pull = forge.createPull(repo, {
        title: needString(args, 'title'),
        body: optString(args, 'body'),
        headRef: needString(args, 'head'),
        baseRef: needString(args, 'base'),
      });
      if (pull === null) throw new ToolError('could not create the pull request from those branches');
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: toolSchema(
      { owner: stringProp('The repository owner'), repo: stringProp('The repository name'), pull_number: { type: 'number', description: 'The pull request number' } },
      ['owner', 'repo', 'pull_number'],
    ),
    run(forge, args) {
      const repo = requireRepo(forge, args);
      const number = args.pull_number;
      if (typeof number !== 'number' || !Number.isInteger(number)) throw new ToolError('missing required argument: pull_number');
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new ToolError(`pull request ${number} not found`);
      if (!pull.merged) {
        const sha = forge.mergePull(repo, pull);
        if (sha === null) throw new ToolError('the pull request has merge conflicts');
      }
      return { ...pullJson(repo, pull), merged: true, sha: pull.mergeCommitSha, message: 'Pull Request successfully merged' };
    },
  },
];

/** The tools/list payload, rebuilt identically on every call. */
function toolsList(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

// ---------------------------------------------------------------- JSON-RPC plumbing

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown> | null;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id as string | number | null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcOutcome {
  return { status, payload: { jsonrpc: '2.0', id: id as string | number | null, error: { code, message } } };
}

/** Dispatch one JSON-RPC request object. Notifications answer with no payload. */
function dispatch(ctx: Ctx, request: Record<string, unknown>): RpcOutcome {
  const id = 'id' in request ? request.id : undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = typeof request.params === 'object' && request.params !== null ? (request.params as Record<string, unknown>) : {};
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: toolsList() });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      // Missing required arguments are a protocol error, not a tool result.
      const schema = tool.inputSchema as { required?: string[] };
      for (const required of schema.required ?? []) {
        if (!(required in args) || args[required] === undefined || args[required] === '') {
          return rpcError(id, -32602, `missing required argument: ${required}`);
        }
      }
      try {
        const value = tool.run(ctx.forge, args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (err) {
        if (err instanceof ToolError) {
          return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        throw err;
      }
    }
    default:
      if (isNotification) return { status: 202, payload: null };
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(ctx: Ctx): Promise<void> {
  if (ctx.method === 'DELETE') {
    // A legacy session goodbye; the forge keeps no sessions.
    ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  if (ctx.method !== 'POST') {
    sendJson(ctx, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } });
    return;
  }
  if (!ctx.authed) {
    sendJson(ctx, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const payloads: unknown[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const outcome = dispatch(ctx, entry as Record<string, unknown>);
      if (outcome.payload !== null) payloads.push(outcome.payload);
    }
    return sendJson(ctx, 200, payloads);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const outcome = dispatch(ctx, parsed as Record<string, unknown>);
  if (outcome.payload === null) {
    ctx.res.writeHead(outcome.status, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  return sendJson(ctx, outcome.status, outcome.payload);
}
