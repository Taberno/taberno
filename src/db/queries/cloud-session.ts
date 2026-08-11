import { db, execute } from '../connection';

/**
 * Records a one-time admin-handoff token's `jti` as consumed, atomically.
 *
 * Returns true if this call was the one that recorded it (the token was unseen
 * and is now spent), false if it was already present (a reuse or replay). The
 * INSERT OR IGNORE relies on the PRIMARY KEY, so two concurrent redemptions of
 * the same token can't both win — SQLite serializes the writes and exactly one
 * sees `changes === 1`.
 */
export function recordJtiIfUnseen(jti: string, exp: number): boolean {
  const result = db.prepare('INSERT OR IGNORE INTO cloud_session_jti (jti, exp) VALUES (?, ?)').run(jti, exp);
  return result.changes > 0;
}

/** Drops spent-token records whose token has already expired — all the cleanup a 60-second token needs. */
export function pruneExpiredJti(now: number): void {
  execute('DELETE FROM cloud_session_jti WHERE exp < ?', [now]);
}
