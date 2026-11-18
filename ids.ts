// Global ids: the opaque, stable identifiers GraphQL's node(id:) and the
// REST `node_id` fields share. An id is the base64 of a typed payload —
// `Repository:3`, `Issue:3:7` — so it never equals the plain database id or
// issue number it wraps, stays identical across reads, and decodes back to
// exactly one object.

export type GlobalId =
  | { readonly type: 'Repository'; readonly repoId: number }
  | { readonly type: 'Issue'; readonly repoId: number; readonly number: number }
  | { readonly type: 'PullRequest'; readonly repoId: number; readonly number: number }
  | { readonly type: 'IssueComment'; readonly repoId: number; readonly issueNumber: number; readonly commentId: number }
  | { readonly type: 'User'; readonly userId: number };

function encode(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64');
}

export function repositoryId(repoId: number): string {
  return encode(`Repository:${repoId}`);
}

export function issueId(repoId: number, number: number): string {
  return encode(`Issue:${repoId}:${number}`);
}

export function pullRequestId(repoId: number, number: number): string {
  return encode(`PullRequest:${repoId}:${number}`);
}

export function commentId(repoId: number, issueNumber: number, id: number): string {
  return encode(`IssueComment:${repoId}:${issueNumber}:${id}`);
}

export function userId(id: number): string {
  return encode(`User:${id}`);
}

/** Decode a global id; null when it is not one of ours. */
export function decodeGlobalId(id: string): GlobalId | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const num = (value: string | undefined): number | null => {
    if (value === undefined || !/^\d+$/.test(value)) return null;
    return Number(value);
  };
  if (parts[0] === 'Repository' && parts.length === 2) {
    const repoId = num(parts[1]);
    return repoId === null ? null : { type: 'Repository', repoId };
  }
  if (parts[0] === 'Issue' && parts.length === 3) {
    const repoId = num(parts[1]);
    const number = num(parts[2]);
    return repoId === null || number === null ? null : { type: 'Issue', repoId, number };
  }
  if (parts[0] === 'PullRequest' && parts.length === 3) {
    const repoId = num(parts[1]);
    const number = num(parts[2]);
    return repoId === null || number === null ? null : { type: 'PullRequest', repoId, number };
  }
  if (parts[0] === 'IssueComment' && parts.length === 4) {
    const repoId = num(parts[1]);
    const issueNumber = num(parts[2]);
    const commentIdValue = num(parts[3]);
    return repoId === null || issueNumber === null || commentIdValue === null
      ? null
      : { type: 'IssueComment', repoId, issueNumber, commentId: commentIdValue };
  }
  if (parts[0] === 'User' && parts.length === 2) {
    const id = num(parts[1]);
    return id === null ? null : { type: 'User', userId: id };
  }
  return null;
}
