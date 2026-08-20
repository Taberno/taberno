import { query, queryOne, execute } from '../connection';

export interface RedirectRow {
  id: string;
  from_path: string;
  to_path: string;
  source: string;
  hits: number;
  created_at: string;
}

/**
 * Normalises a path for storage and lookup so the two always agree: lowercased,
 * leading slash, no trailing slash (Woo URLs carry one; ours don't), root stays
 * '/'. Only the path — a query string, if any, is handled separately by the
 * caller (the '/?p=<id>' redirect key is built literally).
 */
export function normalizeRedirectPath(path: string): string {
  let s = (path || '').trim().toLowerCase();
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

/** Extracts the (normalised) path from a full permalink URL, or null if unusable. */
export function permalinkToPath(permalink: string): string | null {
  if (!permalink) return null;
  try {
    return normalizeRedirectPath(new URL(permalink).pathname);
  } catch {
    return permalink.startsWith('/') ? normalizeRedirectPath(permalink) : null;
  }
}

// System prefixes a redirect row must never hijack, whatever the table says —
// belt-and-braces, since these are all real routes that wouldn't 404 here anyway.
const PROTECTED_PREFIXES = ['/admin', '/checkout', '/cart', '/api', '/webhooks'];

export function isProtectedRedirectPath(path: string): boolean {
  return PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

/**
 * Records a redirect captured during import. Idempotent: re-running the import
 * updates the destination (a slug may have changed) without duplicating the row
 * or resetting its hit count. Refuses a self-referential loop.
 */
export function recordImportRedirect(fromPath: string, toPath: string, source = 'woocommerce-import'): void {
  if (!fromPath || !toPath || fromPath === toPath) return;
  execute(
    `INSERT INTO redirects (id, from_path, to_path, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(from_path) DO UPDATE SET to_path = excluded.to_path, source = excluded.source`,
    [crypto.randomUUID(), fromPath, toPath, source],
  );
}

/**
 * Looks up a redirect by one or more candidate keys (the request's path, and —
 * when it has a query string — its '/?…' form). Prefers the more specific
 * (longer) key when several match. One indexed query, no scans.
 */
export function findRedirect(candidates: string[]): RedirectRow | null {
  const keys = [...new Set(candidates.filter(Boolean))];
  if (keys.length === 0) return null;
  const placeholders = keys.map(() => '?').join(',');
  return queryOne<RedirectRow>(
    `SELECT id, from_path, to_path, source, hits, created_at FROM redirects
     WHERE from_path IN (${placeholders}) ORDER BY length(from_path) DESC LIMIT 1`,
    keys,
  );
}

export function bumpRedirectHits(id: string): void {
  execute('UPDATE redirects SET hits = hits + 1 WHERE id = ?', [id]);
}

export function listRedirects(): RedirectRow[] {
  return query<RedirectRow>(
    'SELECT id, from_path, to_path, source, hits, created_at FROM redirects ORDER BY hits DESC, created_at DESC',
  );
}

/** Adds/updates a manual redirect from the admin. Validates and guards against loops. */
export function addManualRedirect(fromPath: string, toPath: string): { ok: true } | { ok: false; error: string } {
  const from = normalizeRedirectPath(fromPath);
  const to = (toPath || '').trim();
  if (!from || from === '/') return { ok: false, error: 'Enter a path to redirect from (e.g. /old-page).' };
  if (!to.startsWith('/')) return { ok: false, error: 'The destination must be a path starting with “/”.' };
  if (normalizeRedirectPath(to) === from) return { ok: false, error: 'A redirect can’t point to itself.' };
  if (isProtectedRedirectPath(from)) return { ok: false, error: 'That path is reserved and can’t be redirected.' };
  execute(
    `INSERT INTO redirects (id, from_path, to_path, source) VALUES (?, ?, ?, 'manual')
     ON CONFLICT(from_path) DO UPDATE SET to_path = excluded.to_path, source = 'manual'`,
    [crypto.randomUUID(), from, to],
  );
  return { ok: true };
}

export function deleteRedirect(id: string): void {
  execute('DELETE FROM redirects WHERE id = ?', [id]);
}
