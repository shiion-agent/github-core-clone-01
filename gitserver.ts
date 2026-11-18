// Git smart HTTP: the transport the suite's own git client speaks.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack    v2 or v0 advertisement
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack   v0 advertisement
//   POST /{owner}/{repo}.git/git-upload-pack                      v2 ls-refs / fetch (v0 fetch too)
//   POST /{owner}/{repo}.git/git-receive-pack                     v0 push with report-status
//
// The dialect details are the suite's: v2 section headers carry their
// newline, the receive-pack advertisement is v0 only, a refused ref answers
// `ng <ref> non-fast-forward` in those words, and a malformed body must
// never take the server down.

import type { Ctx } from './app.ts';
import { sendBytes, sendError } from './app.ts';
import type { Repo } from './store.ts';
import { PktReader, pktLine, flushPkt, delimPkt, sidebandWrap } from './pktline.ts';
import {
  ZERO_OID,
  collectClosure,
  isAncestor,
  parseCommit,
  parsePack,
  parseTag,
  writePack,
  type GitObject,
} from './gitobjects.ts';

const AGENT = 'forge/1.0.0';
const UPLOAD_CAPS = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not object-format=sha1 agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

export async function handleGit(ctx: Ctx, owner: string, repoName: string, tail: string): Promise<void> {
  const repo = ctx.forge.getRepo(owner, repoName);
  if (repo === undefined) return sendError(ctx, 404, 'Not Found');

  if (tail === 'info/refs') {
    if (ctx.method !== 'GET') return sendError(ctx, 405, 'Method Not Allowed');
    const service = ctx.url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      const v2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
      if (v2) return sendBytes(ctx, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      const caps = `${UPLOAD_CAPS} symref=HEAD:${repo.headRef()}`;
      return sendBytes(ctx, 200, v0Advertisement(ctx, repo, service, caps), 'application/x-git-upload-pack-advertisement');
    }
    if (service === 'git-receive-pack') {
      return sendBytes(ctx, 200, v0Advertisement(ctx, repo, service, RECEIVE_CAPS), 'application/x-git-receive-pack-advertisement');
    }
    return sendError(ctx, 400, 'Missing or unknown service');
  }

  if (tail === 'git-upload-pack') {
    if (ctx.method !== 'POST') return sendError(ctx, 405, 'Method Not Allowed');
    try {
      const v2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
      const result = v2 ? v2UploadPack(ctx, repo) : v0UploadPack(ctx, repo);
      return sendBytes(ctx, 200, result, 'application/x-git-upload-pack-result');
    } catch {
      // A malformed body is a client error, never a server failure.
      return sendBytes(ctx, 200, Buffer.alloc(0), 'application/x-git-upload-pack-result');
    }
  }

  if (tail === 'git-receive-pack') {
    if (ctx.method !== 'POST') return sendError(ctx, 405, 'Method Not Allowed');
    try {
      const result = receivePack(ctx, repo);
      return sendBytes(ctx, 200, result, 'application/x-git-receive-pack-result');
    } catch {
      return sendBytes(ctx, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    }
  }

  return sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- advertisements

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** HEAD first (when it resolves), then every ref in name order, tags peeled. */
function advertisedRefs(ctx: Ctx, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headTip = repo.branchTip(repo.defaultBranch);
  if (headTip !== null) lines.push({ oid: headTip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const object = ctx.forge.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = ctx.forge.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') line.peeled = target;
    }
    lines.push(line);
  }
  return lines;
}

function v0Advertisement(ctx: Ctx, repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
  const refs = advertisedRefs(ctx, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    refs.forEach((line, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${line.oid} ${line.name}${suffix}`));
      if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.name}^{}`));
    });
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    flushPkt(),
  ]);
}

// ---------------------------------------------------------------- v2 commands

/** Read a v2 request: command line, capability lines, delim, argument lines, flush. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const reader = new PktReader(body);
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet.kind === 'end' || packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
  // Lines between the command and the argument section that are not
  // capabilities are arguments; capabilities are `key=value` before the
  // delimiter, which the reader flattened — arguments are recognised by
  // their verbs, so capabilities are simply skipped by the dispatchers.
  return { command, args: lines.slice(1) };
}

function v2UploadPack(ctx: Ctx, repo: Repo): Buffer {
  const { command, args } = parseV2Request(ctx.body);
  if (command === 'ls-refs') return lsRefs(ctx, repo, args);
  if (command === 'fetch') return fetchV2(ctx, repo, args);
  // An unknown command still answers in protocol: an empty flush stream.
  return flushPkt();
}

function lsRefs(ctx: Ctx, repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  // HEAD first, when a prefix admits it.
  if (matches('HEAD')) {
    const target = repo.headRef();
    const tip = repo.branchTip(repo.defaultBranch);
    if (tip !== null) {
      parts.push(pktLine(`${tip} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = ctx.forge.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const target = parseTag(object.data).object;
        const targetObject = ctx.forge.objects.get(target);
        if (targetObject !== undefined && targetObject.type === 'commit') line += ` peeled:${target}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch (shared closure logic)

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

interface FetchOutcome {
  pack: Buffer | null;
  shallowLines: string[];
  commonHaves: string[];
}

/** Work out what a fetch sends: the wants' closure minus the haves' closure. */
function planFetch(ctx: Ctx, repo: Repo, plan: FetchPlan): FetchOutcome {
  void repo;
  const store = ctx.forge.objects;
  const shallowSet = new Set(plan.shallow);
  const haveClosure = collectClosure(store, plan.haves, { stopAt: shallowSet });
  const exclude = new Set<string>(haveClosure.objects.keys());
  const maxDepth = plan.deepen ?? Number.POSITIVE_INFINITY;
  const wantClosure = collectClosure(store, plan.wants, { maxDepth, exclude });
  const sent = wantClosure.objects;
  // Wants that are not commits (a tag, a tree) ride along directly.
  for (const want of plan.wants) {
    if (sent.has(want) || exclude.has(want)) continue;
    const object = store.get(want);
    if (object !== undefined && object.type === 'tag') {
      sent.set(want, object);
      const target = parseTag(object.data).object;
      const peeled = collectClosure(store, [target], { maxDepth, exclude });
      for (const [oid, entry] of peeled.objects) sent.set(oid, entry);
    }
  }
  const shallowLines: string[] = [];
  for (const oid of wantClosure.boundary) {
    if (sent.has(oid)) shallowLines.push(`shallow ${oid}`);
  }
  // A client-shallow commit whose parents all arrived (or were already had)
  // stops being shallow.
  for (const oid of plan.shallow) {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => sent.has(parent) || exclude.has(parent))) {
      shallowLines.push(`unshallow ${oid}`);
    }
  }
  const commonHaves = plan.haves.filter((have) => haveClosure.commits.has(have));
  const pack = sent.size === 0 ? null : writePack([...sent.values()]);
  return { pack, shallowLines, commonHaves };
}

function fetchV2(ctx: Ctx, repo: Repo, args: string[]): Buffer {
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) plan.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) plan.deepen = Number(arg.slice(7).trim());
    else if (arg === 'done') plan.done = true;
  }
  const outcome = planFetch(ctx, repo, plan);
  const parts: Buffer[] = [];
  // Protocol v2 framing, as real git speaks it: sections inside one
  // response are separated by DELIMITER packets, and a single flush ends
  // the response. (A flush after the acknowledgments makes a real git
  // client treat the response as over: "expected packfile to be sent
  // after 'ready'".) After an explicit `done` there is no acknowledgments
  // section at all.
  if (!plan.done) {
    const store = ctx.forge.objects;
    const ready = plan.wants.every((want) => store.has(want));
    parts.push(pktLine('acknowledgments\n'));
    if (outcome.commonHaves.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const have of outcome.commonHaves) parts.push(pktLine(`ACK ${have}\n`));
    }
    if (!ready) {
      // Negotiation continues in a later request; this response is over.
      parts.push(flushPkt());
      return Buffer.concat(parts);
    }
    parts.push(pktLine('ready\n'));
    parts.push(delimPkt());
  }
  if (outcome.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of outcome.shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(delimPkt());
  }
  // The packfile section: always sent once negotiation completes, an
  // empty pack when nothing is new.
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(outcome.pack ?? writePack([]), 1));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v0 fetch

function v0UploadPack(ctx: Ctx, repo: Repo): Buffer {
  const reader = new PktReader(ctx.body);
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], deepen: null, done: true };
  // Section 1: wants and shallow negotiation.
  for (;;) {
    const packet = reader.next();
    if (packet.kind !== 'data') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.deepen = Number(line.slice(7).trim());
  }
  // Section 2: haves and done.
  for (;;) {
    const packet = reader.next();
    if (packet.kind !== 'data') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
  }
  const outcome = planFetch(ctx, repo, plan);
  const parts: Buffer[] = [];
  for (const line of outcome.shallowLines) parts.push(pktLine(`${line}\n`));
  if (outcome.commonHaves.length === 0) parts.push(pktLine('NAK\n'));
  else for (const have of outcome.commonHaves) parts.push(pktLine(`ACK ${have} common\n`));
  if (outcome.pack !== null) parts.push(sidebandWrap(outcome.pack, 1));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(ctx: Ctx, repo: Repo): Buffer {
  const forge = ctx.forge;
  const reader = new PktReader(ctx.body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  let first = true;
  for (;;) {
    const packet = reader.next();
    if (packet.kind !== 'data') break;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const fields = line.split(' ');
    if (fields.length >= 3) {
      commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields.slice(2).join(' ') });
    }
  }
  const pack = reader.remaining;
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      parsePack(forge.objects, pack);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    results.push(applyPushCommand(ctx, repo, command));
  }

  const caps = new Set(capabilities.split(' ').filter((cap) => cap !== ''));
  if (!caps.has('report-status')) return Buffer.alloc(0);
  // Report lines are newline-terminated inside their packets: the reader
  // joins the packet payloads and splits the text on '\n'.
  const reportParts: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(flushPkt());
  const report = Buffer.concat(reportParts);
  if (caps.has('side-band-64k')) return Buffer.concat([sidebandWrap(report, 1), flushPkt()]);
  return report;
}

/** Validate and apply one ref update; the report line for it. */
function applyPushCommand(ctx: Ctx, repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  const forge = ctx.forge;
  const { ref, oldOid, newOid } = command;
  if (!ref.startsWith('refs/')) return { ref, ok: false, reason: 'invalid ref name' };
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // A deletion.
    if (current === ZERO_OID) return { ref, ok: false, reason: 'does not exist' };
    if (current !== oldOid) return { ref, ok: false, reason: 'stale info' };
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const object: GitObject | undefined = forge.objects.get(newOid);
  if (object === undefined) return { ref, ok: false, reason: 'not a valid object' };
  if (current === ZERO_OID) {
    if (oldOid !== ZERO_OID) return { ref, ok: false, reason: 'stale info' };
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  if (current !== oldOid) return { ref, ok: false, reason: 'stale info' };
  if (ref.startsWith('refs/heads/')) {
    if (object.type !== 'commit') return { ref, ok: false, reason: 'not a commit' };
    if (!isAncestor(forge.objects, oldOid, newOid)) return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}
