import type { OAuthSessionLike } from './lib';
import type { BlobRef } from './records';

// The four repo calls the publisher makes, over plain XRPC through the OAuth
// session (which adds DPoP and refreshes tokens). An interface so sync can be
// tested against an in-memory repo.

export type Write =
  | { action: 'create' | 'update'; collection: string; rkey: string; value: Record<string, unknown> }
  | { action: 'delete'; collection: string; rkey: string };

export interface RemoteRecord {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

export interface RepoClient {
  readonly did: string;
  describeRepo(): Promise<{ handle: string | null }>;
  uploadBlob(data: Buffer, mimeType: string): Promise<BlobRef>;
  listRecords(collection: string): Promise<RemoteRecord[]>;
  /** Atomic: all writes apply or none do. Returns the new CID for each create/update, null for deletes. */
  applyWrites(writes: Write[]): Promise<(string | null)[]>;
}

export class XrpcError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly error: string | null,
    message: string,
  ) {
    super(`${method}: ${status}${error ? ` ${error}` : ''}: ${message}`);
  }
}

/** One XRPC call through the session; a non-2xx response throws XrpcError. */
export async function call<T>(session: OAuthSessionLike, method: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<T> {
  const qs = init.query ? `?${new URLSearchParams(init.query)}` : '';
  const res = await session.fetchHandler(`/xrpc/${method}${qs}`, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON error body
  }
  if (!res.ok) {
    throw new XrpcError(method, res.status, typeof body.error === 'string' ? body.error : null, String(body.message ?? text.slice(0, 200)));
  }
  return body as T;
}

const WRITE_TYPES = {
  create: 'com.atproto.repo.applyWrites#create',
  update: 'com.atproto.repo.applyWrites#update',
  delete: 'com.atproto.repo.applyWrites#delete',
} as const;

export function sessionRepoClient(session: OAuthSessionLike): RepoClient {
  const did = session.did;
  return {
    did,
    async describeRepo() {
      const res = await call<{ handle?: string }>(session, 'com.atproto.repo.describeRepo', { query: { repo: did } });
      return { handle: res.handle && res.handle !== 'handle.invalid' ? res.handle : null };
    },
    async uploadBlob(data, mimeType) {
      const res = await call<{ blob: BlobRef }>(session, 'com.atproto.repo.uploadBlob', {
        method: 'POST',
        headers: { 'content-type': mimeType },
        body: new Uint8Array(data),
      });
      return res.blob;
    },
    async listRecords(collection) {
      const out: RemoteRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<{ cursor?: string; records: RemoteRecord[] }>(session, 'com.atproto.repo.listRecords', {
          query: { repo: did, collection, limit: '100', ...(cursor ? { cursor } : {}) },
        });
        out.push(...page.records);
        cursor = page.records.length ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    async applyWrites(writes) {
      const res = await call<{ results?: ({ cid?: string } | undefined)[] }>(session, 'com.atproto.repo.applyWrites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: did,
          writes: writes.map((w) =>
            w.action === 'delete'
              ? { $type: WRITE_TYPES.delete, collection: w.collection, rkey: w.rkey }
              : { $type: WRITE_TYPES[w.action], collection: w.collection, rkey: w.rkey, value: w.value },
          ),
        }),
      });
      return writes.map((_, i) => res.results?.[i]?.cid ?? null);
    },
  };
}
