// GraphQL v4: a hand-written parser and executor over the forge's store.
//
// The suite speaks real GraphQL — variables, aliases, inline fragments,
// input objects, enum literals, batched operations, cursor connections and
// introspection — so this module implements exactly that subset faithfully:
// a tokenizer and recursive-descent parser for documents, and a resolver
// tree for Query, Mutation, Repository, Issue, PullRequest and friends.
// Unknown fields answer the way GitHub answers them: HTTP 200, partial
// data, and an `errors` array naming the field.

import type { Ctx } from './app.ts';
import { sendJson, sendError } from './app.ts';
import type { Forge, Repo, IssueRec, PullRec } from './store.ts';
import { VIEWER } from './viewer.ts';
import * as ids from './ids.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'spread' }
  | { readonly kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push({ kind: 'spread' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') { value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)); j += 4; }
          else throw new Error(`bad string escape \\${esc}`);
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

/** A value in a document: literal, or a variable reference marker. */
export type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { readonly __var: string };

export interface FieldNode {
  readonly name: string;
  readonly alias: string | null;
  readonly args: Record<string, GqlValue>;
  readonly selections: Selection[];
}

export type Selection =
  | { readonly kind: 'field'; readonly field: FieldNode }
  | { readonly kind: 'spread'; readonly name: string }
  | { readonly kind: 'inline'; readonly on: string; readonly selections: Selection[] };

export interface Operation {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly selections: Selection[];
}

export interface Document {
  readonly operations: Operation[];
  readonly fragments: Map<string, Selection[]>;
}

class Parser {
  #tokens: Token[];
  #pos = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }

  next(): Token {
    const token = this.#tokens[this.#pos] as Token;
    this.#pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation or fragment');
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = (this.next() as { value: string }).value;
        if (this.atPunct('(')) this.skipBalanced();
        this.skipDirectives();
        operations.push({ type: token.value, name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('fragment needs a name');
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('fragment needs `on`');
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('fragment needs a type');
        this.skipDirectives();
        fragments.set(nameToken.value, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  skipBalanced(): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parentheses');
      if (token.kind === 'punct' && (token.value === '(' || token.value === '[' || token.value === '{')) depth += 1;
      if (token.kind === 'punct' && (token.value === ')' || token.value === ']' || token.value === '}')) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      const name = this.next();
      if (name.kind !== 'name') throw new Error('directive needs a name');
      if (this.atPunct('(')) this.skipBalanced();
    }
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const type = this.next();
        if (type.kind !== 'name') throw new Error('inline fragment needs a type');
        this.skipDirectives();
        return { kind: 'inline', on: type.value, selections: this.parseSelectionSet() };
      }
      const name = this.next();
      if (name.kind !== 'name') throw new Error('fragment spread needs a name');
      this.skipDirectives();
      return { kind: 'spread', name: name.value };
    }
    // A field.
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.atPunct(':')) {
      this.next();
      const real = this.next();
      if (real.kind !== 'name') throw new Error('alias needs a field name');
      alias = name;
      name = real.value;
    }
    const args = this.atPunct('(') ? this.parseArguments() : {};
    this.skipDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', field: { name, alias, args, selections } };
  }

  parseArguments(): Record<string, GqlValue> {
    this.expectPunct('(');
    const args: Record<string, GqlValue> = {};
    while (!this.atPunct(')')) {
      const key = this.next();
      if (key.kind !== 'name') throw new Error('argument needs a name');
      this.expectPunct(':');
      args[key.value] = this.parseValue();
    }
    this.next();
    return args;
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return token.value;
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('variable needs a name');
      return { __var: name.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const list: GqlValue[] = [];
      while (!this.atPunct(']')) list.push(this.parseValue());
      this.next();
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, GqlValue> = {};
      while (!this.atPunct('}')) {
        const key = this.next();
        if (key.kind !== 'name') throw new Error('input object needs field names');
        this.expectPunct(':');
        object[key.value] = this.parseValue();
      }
      this.next();
      return object;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // an enum literal
    }
    throw new Error('unexpected value');
  }
}

export function parseGraphql(source: string): Document {
  return new Parser(tokenize(source)).parseDocument();
}

/** Substitute variables into a document value. */
function evalValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) return value.map((entry) => evalValue(entry, variables));
    if ('__var' in value) return variables[(value as { __var: string }).__var];
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = evalValue(entry, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- schema data (for introspection)

interface TypeDef {
  readonly kind: 'OBJECT' | 'ENUM';
  readonly fields: readonly string[];
  readonly enumValues: readonly string[];
}

const objectType = (fields: readonly string[]): TypeDef => ({ kind: 'OBJECT', fields, enumValues: [] });
const enumType = (values: readonly string[]): TypeDef => ({ kind: 'ENUM', fields: [], enumValues: values });

export const TYPE_DEFS: Readonly<Record<string, TypeDef>> = {
  Query: objectType(['viewer', 'repository', 'node', 'user', 'search', '__type', '__schema']),
  Mutation: objectType(['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: objectType(['id', 'login', 'name', 'email', 'url']),
  Repository: objectType([
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url',
    'createdAt', 'updatedAt', 'stargazerCount', 'forkCount',
  ]),
  Ref: objectType(['id', 'name', 'prefix', 'target']),
  Issue: objectType(['id', 'number', 'title', 'state', 'body', 'author', 'repository', 'url', 'createdAt', 'updatedAt', 'closed', 'labels']),
  PullRequest: objectType([
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'author', 'repository', 'files', 'url', 'createdAt', 'updatedAt', 'mergeCommit',
  ]),
  IssueComment: objectType(['id', 'body', 'author', 'createdAt', 'updatedAt', 'url']),
  IssueConnection: objectType(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: objectType(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFileConnection: objectType(['nodes', 'edges', 'pageInfo', 'totalCount']),
  IssueEdge: objectType(['node', 'cursor']),
  PullRequestEdge: objectType(['node', 'cursor']),
  PullRequestChangedFileEdge: objectType(['node', 'cursor']),
  PullRequestChangedFile: objectType(['path', 'additions', 'deletions', 'changeType']),
  PageInfo: objectType(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  CreateIssuePayload: objectType(['issue', 'clientMutationId']),
  CloseIssuePayload: objectType(['issue', 'clientMutationId']),
  CreatePullRequestPayload: objectType(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: objectType(['pullRequest', 'clientMutationId']),
  AddCommentPayload: objectType(['commentEdge', 'subject', 'clientMutationId']),
  IssueCommentEdge: objectType(['node', 'cursor']),
  SearchType: enumType(['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'PULL_REQUEST']),
  IssueState: enumType(['OPEN', 'CLOSED']),
  PullRequestState: enumType(['OPEN', 'CLOSED', 'MERGED']),
  MergeableState: enumType(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  OrderDirection: enumType(['ASC', 'DESC']),
  IssueOrderField: enumType(['CREATED_AT', 'UPDATED_AT', 'COMMENTS']),
  PullRequestOrderField: enumType(['CREATED_AT', 'UPDATED_AT']),
  Permission: enumType(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']),
  __Type: objectType(['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType']),
  __Field: objectType(['name', 'description', 'type', 'args']),
  __EnumValue: objectType(['name', 'description']),
  __Schema: objectType(['types', 'queryType', 'mutationType', 'directives']),
};

// ---------------------------------------------------------------- object graph

/** A value the executor walks; `__typename` drives field resolution. */
interface GqlObj {
  __typename: string;
  [key: string]: unknown;
}

function userObj(login: string): GqlObj {
  return { __typename: 'User', login };
}

function repoObj(repo: Repo): GqlObj {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: Repo, issue: IssueRec): GqlObj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: PullRec): GqlObj {
  return { __typename: 'PullRequest', repo, pull };
}

function commentObj(repo: Repo, issue: IssueRec, comment: { id: number; body: string; createdAt: string }): GqlObj {
  return { __typename: 'IssueComment', repo, issue, comment };
}

interface Connection {
  __typename: string;
  items: GqlObj[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
  cursors: Map<GqlObj, string>;
}

function cursorFor(kind: string, key: number): string {
  return Buffer.from(`cursor:${kind}:${key}`, 'utf8').toString('base64');
}

function cursorKey(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:[A-Za-z]+:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Page a list of {number} records into a connection. */
function paginate<T extends { number: number }>(
  typename: string,
  all: T[],
  args: Record<string, unknown>,
  wrap: (item: T) => GqlObj,
): Connection {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : all.length;
  let startIndex = 0;
  if (typeof args.after === 'string') {
    const key = cursorKey(args.after);
    if (key !== null) {
      const at = all.findIndex((item) => item.number === key);
      if (at !== -1) startIndex = at + 1;
    }
  }
  const pageItems = all.slice(startIndex, startIndex + first);
  const cursors = new Map<GqlObj, string>();
  const items = pageItems.map((item) => {
    const wrapped = wrap(item);
    cursors.set(wrapped, cursorFor(typename, item.number));
    return wrapped;
  });
  return {
    __typename: typename,
    items,
    hasNextPage: startIndex + first < all.length,
    endCursor: pageItems.length === 0 ? null : cursorFor(typename, (pageItems[pageItems.length - 1] as T).number),
    startCursor: pageItems.length === 0 ? null : cursorFor(typename, (pageItems[0] as T).number),
    cursors,
  };
}

// ---------------------------------------------------------------- executor

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, Selection[]>;
  errors: Array<{ message: string }>;
}

function typeObj(name: string): GqlObj | null {
  const def = TYPE_DEFS[name];
  if (def === undefined) return null;
  return { __typename: '__Type', name, kind: def.kind, def };
}

/** Decode a global id into the object it names, or null. */
function nodeById(forge: Forge, id: string): GqlObj | null {
  const decoded = ids.decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'User') return { __typename: 'User', login: VIEWER.login };
  const repo = forge.reposById.get(decoded.repoId);
  if (repo === undefined) return null;
  if (decoded.type === 'Repository') return repoObj(repo);
  if (decoded.type === 'Issue') {
    const issue = repo.issues.get(decoded.number);
    return issue === undefined ? null : issueObj(repo, issue);
  }
  if (decoded.type === 'PullRequest') {
    const pull = repo.pulls.get(decoded.number);
    return pull === undefined ? null : pullObj(repo, pull);
  }
  if (decoded.type === 'IssueComment') {
    const issue = repo.issues.get(decoded.issueNumber);
    const comment = issue?.comments.find((entry) => entry.id === decoded.commentId);
    return issue === undefined || comment === undefined ? null : commentObj(repo, issue, comment);
  }
  return null;
}

function resolveField(ctx: ExecCtx, source: GqlObj, field: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  if (field === '__typename') return source.__typename;
  switch (source.__typename) {
    case 'Query': {
      if (field === 'viewer') return userObj(VIEWER.login);
      if (field === 'user') return typeof args.login === 'string' && args.login === VIEWER.login ? userObj(VIEWER.login) : null;
      if (field === 'repository') {
        const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? forge.getRepo(args.owner, args.name) : undefined;
        return repo === undefined ? null : repoObj(repo);
      }
      if (field === 'node') return typeof args.id === 'string' ? nodeById(forge, args.id) : null;
      if (field === '__type') return typeof args.name === 'string' ? typeObj(args.name) : null;
      if (field === '__schema') return { __typename: '__Schema' };
      break;
    }
    case 'Mutation': {
      return resolveMutation(ctx, field, args);
    }
    case 'User': {
      if (field === 'id') return ids.userId(VIEWER.id);
      if (field === 'login') return source.login;
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      break;
    }
    case 'Repository': {
      const repo = source.repo as Repo;
      switch (field) {
        case 'id': return ids.repositoryId(repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return userObj(repo.owner);
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'defaultBranchRef': return { __typename: 'Ref', name: repo.defaultBranch };
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        case 'issue': {
          const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
          return issue === undefined ? null : issueObj(repo, issue);
        }
        case 'issues': {
          let all = [...repo.issues.values()];
          if (Array.isArray(args.states)) {
            const states = args.states.map((state) => String(state).toLowerCase());
            all = all.filter((issue) => states.includes(issue.state));
          }
          const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
          const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
          all.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
          return paginate('IssueConnection', all, args, (issue) => issueObj(repo, issue));
        }
        case 'pullRequest': {
          const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
          return pull === undefined ? null : pullObj(repo, pull);
        }
        case 'pullRequests': {
          let all = [...repo.pulls.values()];
          if (Array.isArray(args.states)) {
            const states = args.states.map((state) => String(state).toUpperCase());
            all = all.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          all.sort((a, b) => a.number - b.number);
          return paginate('PullRequestConnection', all, args, (pull) => pullObj(repo, pull));
        }
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return source.name;
      if (field === 'prefix') return 'refs/heads/';
      break;
    }
    case 'Issue': {
      const repo = source.repo as Repo;
      const issue = source.issue as IssueRec;
      switch (field) {
        case 'id': return ids.issueId(repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'author': return userObj(VIEWER.login);
        case 'repository': return repoObj(repo);
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
      }
      break;
    }
    case 'PullRequest': {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRec;
      switch (field) {
        case 'id': return ids.pullRequestId(repo.id, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'author': return userObj(VIEWER.login);
        case 'repository': return repoObj(repo);
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'mergeable': {
          if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
          return forge.prMergeState(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'files': {
          const files = forge.prFiles(repo, pull).map((file, index) => ({
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
            number: index + 1,
          }));
          return paginate('PullRequestChangedFileConnection', files, args, (file) => file as unknown as GqlObj);
        }
      }
      break;
    }
    case 'IssueComment': {
      const repo = source.repo as Repo;
      const issue = source.issue as IssueRec;
      const comment = source.comment as { id: number; body: string; createdAt: string };
      switch (field) {
        case 'id': return ids.commentId(repo.id, issue.number, comment.id);
        case 'body': return comment.body;
        case 'author': return userObj(VIEWER.login);
        case 'createdAt': return comment.createdAt;
        case 'updatedAt': return comment.createdAt;
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return source.path;
      if (field === 'additions') return source.additions;
      if (field === 'deletions') return source.deletions;
      if (field === 'changeType') return source.changeType;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const connection = source as unknown as Connection;
      if (field === 'nodes') return connection.items;
      if (field === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: connection.hasNextPage,
          hasPreviousPage: false,
          startCursor: connection.startCursor,
          endCursor: connection.endCursor,
        };
      }
      if (field === 'totalCount') return connection.items.length;
      if (field === 'edges') {
        return connection.items.map((item) => ({
          __typename: source.__typename.replace('Connection', 'Edge'),
          node: item,
          cursor: connection.cursors.get(item) ?? null,
        }));
      }
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'IssueCommentEdge': {
      if (field === 'node') return source.node;
      if (field === 'cursor') return source.cursor;
      break;
    }
    case 'PageInfo': {
      if (field in source) return source[field];
      break;
    }
    case '__Type': {
      const def = source.def as TypeDef;
      if (field === 'name') return source.name;
      if (field === 'kind') return def.kind;
      if (field === 'description') return null;
      if (field === 'fields') return def.fields.map((name) => ({ __typename: '__Field', name }));
      if (field === 'enumValues') return def.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
      if (field === 'possibleTypes') return [];
      if (field === 'inputFields') return [];
      if (field === 'ofType') return null;
      break;
    }
    case '__Field': {
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      break;
    }
    case '__Schema': {
      if (field === 'queryType') return typeObj('Query');
      if (field === 'mutationType') return typeObj('Mutation');
      if (field === 'types') return Object.keys(TYPE_DEFS).map((name) => typeObj(name));
      if (field === 'directives') return [];
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return source.issue;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return source.pullRequest;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return source.commentEdge;
      if (field === 'subject') return source.subject;
      if (field === 'clientMutationId') return null;
      break;
    }
  }
  ctx.errors.push({ message: `Field '${field}' doesn't exist on type '${source.__typename}'` });
  return null;
}

/** Mutation resolvers: each returns its payload object. */
function resolveMutation(ctx: ExecCtx, field: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const decoded = typeof input.repositoryId === 'string' ? ids.decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.type === 'Repository' ? forge.reposById.get(decoded.repoId) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'repositoryId does not name a repository' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const issue = forge.createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    }
    case 'closeIssue':
    case 'reopenIssue': {
      const target = typeof input.issueId === 'string' ? nodeById(forge, input.issueId) : null;
      if (target === null || target.__typename !== 'Issue') {
        ctx.errors.push({ message: 'issueId does not name an issue' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      const issue = target.issue as IssueRec;
      issue.state = field === 'closeIssue' ? 'closed' : 'open';
      issue.updatedAt = forge.nowIso();
      return { __typename: 'CloseIssuePayload', issue: target };
    }
    case 'createPullRequest': {
      const decoded = typeof input.repositoryId === 'string' ? ids.decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.type === 'Repository' ? forge.reposById.get(decoded.repoId) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'repositoryId does not name a repository' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const pull = forge.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef: typeof input.headRefName === 'string' ? input.headRefName : '',
        baseRef: typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
      });
      if (pull === null) {
        ctx.errors.push({ message: 'could not create the pull request from those branches' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
    }
    case 'mergePullRequest': {
      const target = typeof input.pullRequestId === 'string' ? nodeById(forge, input.pullRequestId) : null;
      if (target === null || target.__typename !== 'PullRequest') {
        ctx.errors.push({ message: 'pullRequestId does not name a pull request' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const repo = target.repo as Repo;
      const pull = target.pull as PullRec;
      if (!pull.merged) {
        const sha = forge.mergePull(repo, pull);
        if (sha === null) ctx.errors.push({ message: 'the pull request has merge conflicts' });
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: target };
    }
    case 'addComment': {
      const target = typeof input.subjectId === 'string' ? nodeById(forge, input.subjectId) : null;
      if (target === null || target.__typename !== 'Issue') {
        ctx.errors.push({ message: 'subjectId does not name an issue' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const repo = target.repo as Repo;
      const issue = target.issue as IssueRec;
      const comment = {
        id: forge.nextCommentId(),
        body: typeof input.body === 'string' ? input.body : '',
        createdAt: forge.nowIso(),
      };
      issue.comments.push(comment);
      issue.updatedAt = comment.createdAt;
      const node = commentObj(repo, issue, comment);
      return {
        __typename: 'AddCommentPayload',
        subject: target,
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: null },
      };
    }
  }
  ctx.errors.push({ message: `Field '${field}' doesn't exist on type 'Mutation'` });
  return null;
}

/** Execute one selection set against one object; null in, null out. */
function executeSet(ctx: ExecCtx, source: GqlObj | null, selections: Selection[]): unknown {
  if (source === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSet(ctx, source, fragment) as Record<string, unknown>);
      continue;
    }
    if (selection.kind === 'inline') {
      if (source.__typename === selection.on) Object.assign(out, executeSet(ctx, source, selection.selections) as Record<string, unknown>);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(field.args)) args[name] = evalValue(value, ctx.variables);
    const value = resolveField(ctx, source, field.name, args);
    out[key] = completeValue(ctx, value, field.selections);
  }
  return out;
}

/** Apply a field's sub-selections to its resolved value. */
function completeValue(ctx: ExecCtx, value: unknown, selections: Selection[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selections));
  if (typeof value === 'object' && selections.length > 0) return executeSet(ctx, value as GqlObj, selections);
  return value;
}

/** Run one operation document; answers the {data, errors?} envelope. */
export function executeGraphql(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): { data: unknown; errors?: Array<{ message: string }> } {
  let document: Document;
  try {
    document = parseGraphql(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operationName !== undefined && operationName !== ''
    ? document.operations.find((entry) => entry.name === operationName) ?? document.operations[0]
    : document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  const root: GqlObj = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSet(ctx, root, operation.selections);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------- the HTTP endpoint

export async function handleGraphql(ctx: Ctx): Promise<void> {
  if (ctx.method !== 'POST') return sendError(ctx, 405, 'Method Not Allowed');
  if (!ctx.authed) return sendError(ctx, 401, 'Bad credentials');
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
  const runOne = (entry: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'operation must be an object' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = typeof record.variables === 'object' && record.variables !== null ? (record.variables as Record<string, unknown>) : {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    if (query === '') return { data: null, errors: [{ message: 'query is required' }] };
    return executeGraphql(ctx.forge, query, variables, operationName);
  };
  if (Array.isArray(parsed)) return sendJson(ctx, 200, parsed.map(runOne));
  return sendJson(ctx, 200, runOne(parsed));
}
