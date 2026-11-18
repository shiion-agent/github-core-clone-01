// The forge's state and domain operations.
//
// One Forge holds every repository. A repository is metadata (owner, name,
// description, privacy, default branch), a ref table into the shared object
// store, and the issue / pull-request / label records the API surfaces
// share. REST, GraphQL and MCP are thin serializers over this module, so an
// object created through one surface is the same object through the others.
//
// The clock is a counter, not the wall: timestamps derive from a fixed
// epoch plus a sequence number, so a given sequence of requests always
// produces the same bytes.

import {
  ObjectStore,
  buildCommit,
  buildTreeFromFlat,
  commitAncestors,
  flattenTree,
  isAncestor,
  lineDiffCounts,
  mergeBase,
  parseCommit,
  type GitObject,
} from './gitobjects.ts';
import { VIEWER } from './viewer.ts';

/** 2025-01-01T00:00:00Z: where the forge's deterministic clock starts. */
const EPOCH_SEC = 1_735_689_600;

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  number: number;
  restId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  number: number;
  restId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** The base branch's tip when the pull request was opened. */
  baseShaAtCreate: string | null;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRec>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  nextNumber = 1;
  readonly createdAt: string;
  updatedAt: string;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, stamp: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAt = stamp;
    this.updatedAt = stamp;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** The commit a branch points at, or null when the branch does not exist. */
  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }
}

export class Forge {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  #nextRepoId = 1;
  #nextRestId = 1;
  #nextCommentId = 1;
  #seq = 0;

  /** The next deterministic timestamp, as an ISO string. */
  nowIso(): string {
    this.#seq += 1;
    return new Date((EPOCH_SEC + this.#seq) * 1000).toISOString();
  }

  /** The next deterministic timestamp, as unix seconds. */
  nowUnix(): number {
    this.#seq += 1;
    return EPOCH_SEC + this.#seq;
  }

  /** A git identity line for commits the API itself authors. */
  identityLine(): string {
    return `${VIEWER.name} <${VIEWER.email}> ${this.nowUnix()} +0000`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, options: { description?: string; isPrivate?: boolean } = {}): Repo | null {
    const key = this.repoKey(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    const stamp = this.nowIso();
    const repo = new Repo(this.#nextRepoId, VIEWER.login, name, options.description ?? '', options.isPrivate ?? false, stamp);
    this.#nextRepoId += 1;
    this.repos.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (repo === undefined) return false;
    this.repos.delete(this.repoKey(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  /** The viewer's repositories in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.id - b.id);
  }

  nextRestId(): number {
    const id = this.#nextRestId;
    this.#nextRestId += 1;
    return id;
  }

  /** Create an issue record (the REST handler validates labels before this). */
  createIssue(repo: Repo, input: { title: string; body: string; labels?: string[] }): IssueRec {
    const stamp = this.nowIso();
    const issue: IssueRec = {
      number: repo.nextNumber,
      restId: this.nextRestId(),
      title: input.title,
      body: input.body,
      state: 'open',
      labels: input.labels ?? [],
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    repo.updatedAt = stamp;
    return issue;
  }

  /**
   * Create a pull request record, or null when the branches do not support
   * one (a missing branch, no commits between them, or an open duplicate).
   */
  createPull(repo: Repo, input: { title: string; body: string; headRef: string; baseRef: string }): PullRec | null {
    const headTip = repo.branchTip(input.headRef);
    const baseTip = repo.branchTip(input.baseRef);
    if (headTip === null || baseTip === null || headTip === baseTip) return null;
    const duplicate = [...repo.pulls.values()].find(
      (pull) => pull.state === 'open' && pull.headRef === input.headRef && pull.baseRef === input.baseRef,
    );
    if (duplicate !== undefined) return null;
    const stamp = this.nowIso();
    const pull: PullRec = {
      number: repo.nextNumber,
      restId: this.nextRestId(),
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      baseShaAtCreate: baseTip,
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    repo.updatedAt = stamp;
    return pull;
  }

  nextCommentId(): number {
    const id = this.#nextCommentId;
    this.#nextCommentId += 1;
    return id;
  }

  // ------------------------------------------------------------ git helpers

  /** The tree a commit holds, or null. */
  commitTree(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** The flattened file map of a branch's tip (empty when the branch is unborn). */
  branchFiles(repo: Repo, branch: string): Map<string, { mode: string; oid: string }> {
    const tip = repo.branchTip(branch);
    if (tip === null) return new Map();
    const tree = this.commitTree(tip);
    if (tree === null) return new Map();
    return flattenTree(this.objects, tree);
  }

  /**
   * Commit a whole file map onto a branch, creating the branch (from the
   * default branch's tip, or unborn) when it does not exist yet.
   */
  commitFiles(repo: Repo, branch: string, flat: ReadonlyMap<string, { mode: string; oid: string }>, message: string): string {
    let tip = repo.branchTip(branch);
    if (tip === null && branch !== repo.defaultBranch) tip = repo.branchTip(repo.defaultBranch);
    const tree = buildTreeFromFlat(this.objects, flat);
    const identity = this.identityLine();
    const commit = buildCommit({
      tree,
      parents: tip === null ? [] : [tip],
      author: identity,
      committer: identity,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = this.objects.put('commit', commit);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.updatedAt = this.nowIso();
    return oid;
  }

  /** Create or replace one file on a branch; answers the new commit and blob ids. */
  writeFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitOid: string; blobOid: string; created: boolean } {
    const flat = this.branchFiles(repo, branch);
    const created = !flat.has(path);
    const blobOid = this.objects.put('blob', content);
    flat.set(path, { mode: '100644', oid: blobOid });
    const commitOid = this.commitFiles(repo, branch, flat, message);
    return { commitOid, blobOid, created };
  }

  /** Remove one file from a branch; answers the new commit id. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string {
    const flat = this.branchFiles(repo, branch);
    flat.delete(path);
    return this.commitFiles(repo, branch, flat, message);
  }

  /** Commits reachable from a tip, newest first (depth-first pre-order). */
  listCommits(startOid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (oid: string): void => {
      if (seen.has(oid)) return;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return;
      seen.add(oid);
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) visit(parent);
    };
    visit(startOid);
    return out;
  }

  commitAncestorsOf(oid: string): Set<string> {
    return commitAncestors(this.objects, [oid]);
  }

  isAncestorOf(ancestor: string, descendant: string): boolean {
    return isAncestor(this.objects, ancestor, descendant);
  }

  // ------------------------------------------------------------ pull requests

  /** The file-level three-way state of a pull request against its base today. */
  prMergeState(repo: Repo, pull: PullRec): { headTip: string | null; baseTip: string | null; conflict: boolean; mergedTree: Map<string, { mode: string; oid: string }> | null } {
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === null || baseTip === null) return { headTip, baseTip, conflict: true, mergedTree: null };
    const base = mergeBase(this.objects, headTip, baseTip);
    const baseTree = base === null ? new Map<string, { mode: string; oid: string }>() : this.treeFiles(base);
    const headTree = this.treeFiles(headTip);
    const currentTree = this.treeFiles(baseTip);
    const mergedTree = new Map<string, { mode: string; oid: string }>();
    const paths = new Set<string>([...baseTree.keys(), ...headTree.keys(), ...currentTree.keys()]);
    let conflict = false;
    for (const path of paths) {
      const inBase = baseTree.get(path);
      const inHead = headTree.get(path);
      const inCurrent = currentTree.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
      if (same(inHead, inCurrent)) {
        if (inCurrent !== undefined) mergedTree.set(path, inCurrent);
      } else if (same(inBase, inCurrent)) {
        // Only the head side changed it.
        if (inHead !== undefined) mergedTree.set(path, inHead);
      } else if (same(inBase, inHead)) {
        // Only the base side changed it.
        if (inCurrent !== undefined) mergedTree.set(path, inCurrent);
      } else {
        conflict = true;
      }
    }
    return { headTip, baseTip, conflict, mergedTree: conflict ? null : mergedTree };
  }

  /** The flattened files of a commit's tree. */
  treeFiles(commitOid: string): Map<string, { mode: string; oid: string }> {
    const tree = this.commitTree(commitOid);
    if (tree === null) return new Map();
    return flattenTree(this.objects, tree);
  }

  /**
   * Merge a pull request into its base branch as one squash commit.
   * Answers the merge commit id, or null when the merge conflicts.
   */
  mergePull(repo: Repo, pull: PullRec): string | null {
    const state = this.prMergeState(repo, pull);
    if (state.conflict || state.mergedTree === null || state.baseTip === null) return null;
    const tree = buildTreeFromFlat(this.objects, state.mergedTree);
    const identity = this.identityLine();
    const body = pull.body.trim() === '' ? '' : `\n\n${pull.body}`;
    const commit = buildCommit({
      tree,
      parents: [state.baseTip],
      author: identity,
      committer: identity,
      message: `${pull.title} (#${pull.number})${body}\n`,
    });
    const oid = this.objects.put('commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = oid;
    pull.updatedAt = this.nowIso();
    repo.updatedAt = pull.updatedAt;
    return oid;
  }

  /** The changed files of a pull request: merge-base tree versus head tree. */
  prFiles(repo: Repo, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }> {
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (headTip === null || baseTip === null) return [];
    const base = mergeBase(this.objects, headTip, baseTip) ?? pull.baseShaAtCreate ?? baseTip;
    const fromTree = this.treeFiles(base);
    const toTree = this.treeFiles(headTip);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }> = [];
    const paths = new Set<string>([...fromTree.keys(), ...toTree.keys()]);
    for (const path of [...paths].sort()) {
      const from = fromTree.get(path);
      const to = toTree.get(path);
      if (from?.oid === to?.oid && from?.mode === to?.mode) continue;
      const oldText = from === undefined ? null : (this.objects.get(from.oid)?.data.toString('utf8') ?? null);
      const newText = to === undefined ? null : (this.objects.get(to.oid)?.data.toString('utf8') ?? null);
      const counts = lineDiffCounts(oldText, newText);
      out.push({
        filename: path,
        status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        sha: to?.oid ?? from?.oid ?? '',
      });
    }
    return out;
  }
}

/** Re-export for serializers that need raw object access by id. */
export type { GitObject };
