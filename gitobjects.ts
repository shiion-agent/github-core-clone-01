// The git object layer: SHA-1 addressed objects, trees, commits, tags, packs.
//
// Everything the forge stores is a git object — the REST contents API, the
// merge machinery and the smart-HTTP transport all read and write through
// this module, so the four surfaces can never disagree about what a
// repository holds. Objects live in one content-addressed map; a repository
// is only a set of refs into it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: readonly GitObjectType[] = ['commit', 'tree', 'blob', 'tag', 'tag', 'tag', 'tag', 'tag'];

/** The object id of a payload: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** The content-addressed object store shared by every repository. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObject(object: GitObject): string {
    return this.put(object.type, object.data);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  /** Raw git mode: '40000' for a directory, '100644'/'100755'/'120000' for a leaf. */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: bytewise by name, directories sorting as `name + '/'`. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const keyA = a.mode === '40000' ? `${a.name}/` : a.name;
  const keyB = b.mode === '40000' ? `${b.name}/` : b.name;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/** Serialise entries into a tree object (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file under a tree, flattened to `path -> {mode, oid}`. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build (and store) the nested trees for a flattened file map; answers the root tree id. */
export function buildTreeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, file] of flat) {
    const segments = path.split('/');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let next = dir.dirs.get(name);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push({ mode: file.mode, name: segments[segments.length - 1] as string, oid: file.oid });
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [...dir.files];
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  /** Author timestamp, seconds since the epoch (0 when unparseable). */
  timestamp: number;
  message: string;
}

/** Parse a commit object. Header continuations (signatures) are skipped, not understood. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const stamp = / (\d+) [+-]\d{4}$/.exec(author);
  return { tree, parents, author, committer, timestamp: stamp === null ? 0 : Number(stamp[1]), message };
}

/** Serialise a commit. `author`/`committer` are full `Name <email> ts tz` lines. */
export function buildCommit(input: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  let out = `tree ${input.tree}\n`;
  for (const parent of input.parents) out += `parent ${parent}\n`;
  out += `author ${input.author}\ncommitter ${input.committer}\n\n${input.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message: split === -1 ? '' : text.slice(split + 2) };
}

/** The commit a (possibly annotated) ref target ultimately names, or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- ancestry

/** Every commit reachable from `tips` (following parents), tips included. */
export function commitAncestors(store: ObjectStore, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return commitAncestors(store, [descendant]).has(ancestor);
}

/** A best common ancestor of two commits (the merge base), or null when unrelated. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = commitAncestors(store, [a]);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- packs

/** Serialise objects into a version-2 pack with a correct SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const size = object.data.length;
    let first = (TYPE_CODES[object.type] << 4) | (size & 0x0f);
    const varint: number[] = [];
    let rest = size >> 4;
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      varint.push(byte);
    }
    if (varint.length > 0) first |= 0x80;
    parts.push(Buffer.from([first, ...varint]));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta payload to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: delta expects ${sourceSize}, base is ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset] as number;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (opcode & 0x01) { copyOffset = delta[offset] as number; offset += 1; }
      if (opcode & 0x02) { copyOffset |= (delta[offset] as number) << 8; offset += 1; }
      if (opcode & 0x04) { copyOffset |= (delta[offset] as number) << 16; offset += 1; }
      if (opcode & 0x08) { copyOffset |= (delta[offset] as number) << 24; offset += 1; }
      if (opcode & 0x10) { copySize = delta[offset] as number; offset += 1; }
      if (opcode & 0x20) { copySize |= (delta[offset] as number) << 8; offset += 1; }
      if (opcode & 0x40) { copySize |= (delta[offset] as number) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode > 0) {
      out.push(delta.subarray(offset, offset + opcode));
      offset += opcode;
      produced += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  return result;
}

export interface ParsedPack {
  /** Every object the pack carried, deltas resolved, in pack order. */
  objects: GitObject[];
  count: number;
}

/**
 * Parse a pack into the store, verifying the trailer and every object's id.
 * Delta bases may come from earlier in the pack or from the store itself.
 */
export function parsePack(store: ObjectStore, pack: Buffer): ParsedPack {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const end = pack.length - 20;
  let offset = 12;
  const parsed: GitObject[] = [];
  const localBases = new Map<number, GitObject>();
  for (let index = 0; index < count; index += 1) {
    const entryStart = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: GitObject | undefined;
    let type: GitObjectType;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset varint back to the base's entry.
      let back = pack[offset] as number;
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      base = localBases.get(entryStart - value);
      if (base === undefined) throw new Error('ofs-delta base is not in the pack');
      type = base.type;
    } else if (typeCode === 7) {
      // REF_DELTA: the base's object id, from this pack or the store.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      base = store.get(baseOid);
      if (base === undefined) {
        for (const candidate of parsed) {
          if (hashObject(candidate.type, candidate.data) === baseOid) { base = candidate; break; }
        }
      }
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is unknown`);
      type = base.type;
    } else {
      type = CODE_TYPES[typeCode] as GitObjectType;
    }
    // With {info: true}, engine.bytesWritten is the number of compressed
    // bytes the inflater consumed — how far this entry reached in the pack.
    const inflated = inflateSync(pack.subarray(offset, end), { info: true });
    const raw = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    if (raw.length !== size) throw new Error(`pack entry size mismatch: header says ${size}, inflated ${raw.length}`);
    const data = base === undefined ? raw : applyDelta(base.data, raw);
    const object: GitObject = { type, data };
    parsed.push(object);
    localBases.set(entryStart, object);
  }
  if (offset !== end) throw new Error('pack has trailing bytes before its trailer');
  for (const object of parsed) store.putObject(object);
  return { objects: parsed, count };
}

// ---------------------------------------------------------------- closures for upload-pack

export interface ClosureResult {
  /** Objects to send, keyed by id. */
  objects: Map<string, GitObject>;
  /** Commits in the sent set whose parents were cut off by the depth limit. */
  boundary: Set<string>;
  /** Commits the walk included (before have-exclusion). */
  commits: Set<string>;
}

/**
 * The closure of `tips`: every commit within `maxDepth` (1 = tips only,
 * Infinity = full history), each with its full tree. Commits in `stopAt`
 * count as present-but-parentless (a client's shallow boundary). Objects in
 * `exclude` (a closure computed the same way over the client's haves) are
 * left out of the result.
 */
export function collectClosure(
  store: ObjectStore,
  tips: readonly string[],
  options: { maxDepth?: number; stopAt?: ReadonlySet<string>; exclude?: ReadonlySet<string> } = {},
): ClosureResult {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const stopAt = options.stopAt ?? new Set<string>();
  const exclude = options.exclude ?? new Set<string>();
  const objects = new Map<string, GitObject>();
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const addTree = (treeOid: string): void => {
    if (exclude.has(treeOid) || objects.has(treeOid)) return;
    const tree = store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    objects.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else if (!exclude.has(entry.oid) && !objects.has(entry.oid)) {
        const blob = store.get(entry.oid);
        if (blob !== undefined) objects.set(entry.oid, blob);
      }
    }
  };
  // Breadth-first by depth so the depth limit cuts ancestry, never trees.
  let frontier: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 1 }));
  const visited = new Set<string>();
  while (frontier.length > 0) {
    const next: Array<{ oid: string; depth: number }> = [];
    for (const { oid, depth } of frontier) {
      if (visited.has(oid)) continue;
      visited.add(oid);
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      commits.add(oid);
      const info = parseCommit(object.data);
      const cut = depth >= maxDepth || stopAt.has(oid);
      if (!exclude.has(oid)) {
        objects.set(oid, object);
        addTree(info.tree);
        if (cut && info.parents.length > 0) boundary.add(oid);
      }
      if (!cut) for (const parent of info.parents) next.push({ oid: parent, depth: depth + 1 });
    }
    frontier = next;
  }
  return { objects, boundary, commits };
}

/** Line-level additions/deletions between two blob contents (LCS over lines). */
export function lineDiffCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null || oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === null || newText === '' ? [] : newText.split('\n');
  // Classic LCS dynamic program; the files this forge diffs are small.
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}
