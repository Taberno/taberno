import { execute, query, queryOne } from '../db/connection';
import { decrypt, encrypt } from './secrets';

// Database access for the atproto publisher.

export interface AccountRow {
  did: string;
  handle: string | null;
  pds: string | null;
  connected_at: string;
}

export interface RecordRow {
  local_key: string;
  did: string;
  collection: string;
  rkey: string;
  hash: string;
  cid: string | null;
  synced_at: string;
}

export interface SyncRunRow {
  id: number;
  trigger: string;
  status: 'running' | 'completed' | 'failed';
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  message: string | null;
  started_at: string;
  finished_at: string | null;
}

export function getAccount(): AccountRow | null {
  return queryOne<AccountRow>('SELECT did, handle, pds, connected_at FROM atproto_account WHERE id = 1');
}

export function saveAccount(did: string, handle: string | null): void {
  execute(
    `INSERT INTO atproto_account (id, did, handle) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET did = excluded.did, handle = excluded.handle, connected_at = datetime('now')`,
    [did, handle],
  );
}

export function clearAccount(): void {
  execute('DELETE FROM atproto_account');
  execute(`DELETE FROM atproto_oauth_store WHERE kind IN ('session', 'state')`);
}

// --- encrypted OAuth store --------------------------------------------------

export function getSecret<T>(kind: string, key: string): T | undefined {
  const row = queryOne<{ value: string }>('SELECT value FROM atproto_oauth_store WHERE kind = ? AND key = ?', [kind, key]);
  if (!row) return undefined;
  const json = decrypt(row.value);
  return json === null ? undefined : (JSON.parse(json) as T);
}

export function setSecret(kind: string, key: string, value: unknown): void {
  execute(
    `INSERT INTO atproto_oauth_store (kind, key, value) VALUES (?, ?, ?)
     ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [kind, key, encrypt(JSON.stringify(value))],
  );
}

export function deleteSecret(kind: string, key: string): void {
  execute('DELETE FROM atproto_oauth_store WHERE kind = ? AND key = ?', [kind, key]);
}

// --- published records --------------------------------------------------------

export function recordRows(did: string): RecordRow[] {
  return query<RecordRow>('SELECT * FROM atproto_records WHERE did = ?', [did]);
}

export function upsertRecordRow(did: string, localKey: string, collection: string, rkey: string, hash: string, cid: string | null): void {
  execute(
    `INSERT INTO atproto_records (local_key, did, collection, rkey, hash, cid) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(did, local_key) DO UPDATE SET collection = excluded.collection, rkey = excluded.rkey,
       hash = excluded.hash, cid = excluded.cid, synced_at = datetime('now')`,
    [localKey, did, collection, rkey, hash, cid],
  );
}

export function deleteRecordRow(did: string, localKey: string): void {
  execute('DELETE FROM atproto_records WHERE did = ? AND local_key = ?', [did, localKey]);
}

export function recordCounts(did: string): { collection: string; n: number }[] {
  return query<{ collection: string; n: number }>(
    'SELECT collection, COUNT(*) AS n FROM atproto_records WHERE did = ? GROUP BY collection ORDER BY collection',
    [did],
  );
}

// --- blobs ------------------------------------------------------------------

export function getBlob(did: string, fileHash: string): unknown | null {
  const row = queryOne<{ blob: string }>('SELECT blob FROM atproto_blobs WHERE did = ? AND file_hash = ?', [did, fileHash]);
  return row ? JSON.parse(row.blob) : null;
}

export function saveBlob(did: string, fileHash: string, blob: unknown): void {
  execute('INSERT OR REPLACE INTO atproto_blobs (did, file_hash, blob) VALUES (?, ?, ?)', [did, fileHash, JSON.stringify(blob)]);
}

export function forgetBlobs(did: string): void {
  execute('DELETE FROM atproto_blobs WHERE did = ?', [did]);
}

// --- sync runs ------------------------------------------------------------------

export function startRun(trigger: string): number {
  const row = queryOne<{ id: number }>('INSERT INTO atproto_sync_runs (trigger) VALUES (?) RETURNING id', [trigger]);
  return row!.id;
}

export function finishRun(
  id: number,
  status: 'completed' | 'failed',
  counts: { created: number; updated: number; deleted: number; skipped: number } | null,
  message: string | null,
): void {
  execute(
    `UPDATE atproto_sync_runs SET status = ?, created = ?, updated = ?, deleted = ?, skipped = ?, message = ?,
       finished_at = datetime('now') WHERE id = ?`,
    [status, counts?.created ?? 0, counts?.updated ?? 0, counts?.deleted ?? 0, counts?.skipped ?? 0, message, id],
  );
}

export function recentRuns(limit = 10): SyncRunRow[] {
  return query<SyncRunRow>('SELECT * FROM atproto_sync_runs ORDER BY id DESC LIMIT ?', [limit]);
}

/** A run left 'running' by a crash or restart can never finish; close it out. */
export function failStaleRuns(): void {
  execute(`UPDATE atproto_sync_runs SET status = 'failed', message = 'interrupted', finished_at = datetime('now') WHERE status = 'running'`);
}
