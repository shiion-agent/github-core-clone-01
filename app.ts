// The HTTP surface: one server, four protocols.
//
//   GET  /healthz                       the env's boot probe
//   *    /api/v3/...                    REST v3 (rest.ts)
//   POST /api/graphql                   GraphQL v4 (graphql.ts)
//   *    /mcp                           MCP over JSON-RPC (mcp.ts)
//   *    /{owner}/{repo}.git/...        git smart HTTP (gitserver.ts)
//
// Everything else is GitHub's JSON 404. Every API reply is JSON with a
// non-empty X-GitHub-Request-Id; the git transport answers in its own
// content types, as the protocol requires.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitserver.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** What one request hands to a surface handler. */
export interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  /** The request URL, parsed. */
  url: URL;
  /** The decoded, still-encoded-segment path (segments decoded per surface). */
  path: string;
  method: string;
  /** The full request body (empty for bodyless requests). */
  body: Buffer;
  requestId: string;
  /** The configured bearer token (MAKEFUN_SHOP_TOKEN), '' when unset. */
  token: string;
  /** Whether the request presented the configured token. */
  authed: boolean;
}

let requestSeq = 0;

/** A deterministic, always non-empty request id. */
export function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

/** Answer with a JSON body and the forge's standard API headers. */
export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(text);
}

/** Answer with raw bytes (the git transport). */
export function sendBytes(ctx: Ctx, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(body);
}

/** GitHub's error shape: a JSON object with a non-empty string message. */
export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** Read a whole request body, with a generous cap for pack uploads. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Route one request to its surface; never throws out of the handler. */
async function dispatch(ctx: Ctx): Promise<void> {
  const { path, method } = ctx;

  if (method === 'GET' && path === '/healthz') {
    sendJson(ctx, 200, { ok: true });
    return;
  }
  if (path === '/api/graphql') {
    await handleGraphql(ctx);
    return;
  }
  if (path === '/mcp') {
    await handleMcp(ctx);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(ctx);
    return;
  }
  const git = GIT_PATH.exec(path);
  if (git !== null) {
    await handleGit(ctx, decodeURIComponent(git[1] as string), decodeURIComponent(git[2] as string), git[3] as string);
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(forge: Forge = new Forge()): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req, res) => {
    void (async () => {
      const requestId = nextRequestId();
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        url = new URL('/', 'http://entry');
      }
      const authorization = req.headers.authorization ?? '';
      const ctx: Ctx = {
        forge,
        req,
        res,
        url,
        path: url.pathname,
        method: (req.method ?? 'GET').toUpperCase(),
        body: Buffer.alloc(0),
        requestId,
        token,
        authed: token === '' || authorization === `Bearer ${token}`,
      };
      try {
        ctx.body = await readBody(req);
        await dispatch(ctx);
      } catch (err) {
        // A handler failure must never take the server down with it.
        try {
          if (!res.headersSent) sendError(ctx, 500, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
          else res.end();
        } catch {
          // The peer is gone; nothing left to answer.
        }
      }
    })();
  });
  return server;
}
