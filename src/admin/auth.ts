import argon2 from 'argon2';
import { findAdminByEmail, findAdminById, countAdminUsers, createFirstAdminUser } from '../db/queries/admin';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'staff';
  twoFactorEnabled: boolean;
  /** False for an account created via the Taberno Cloud handoff, which has no
   *  password until the owner sets one from their account page. */
  hasPassword: boolean;
}

// Verified against on an unknown-email login so the response takes roughly
// the same time either way — otherwise "no such account" returns near-
// instantly while a real account takes ~35ms for the argon2id verify,
// letting an attacker enumerate valid emails purely by timing.
const DUMMY_HASH_FOR_TIMING = '$argon2id$v=19$m=65536,t=3,p=4$b4sHhkexu0HRu/yVtAa5Lg$uxd90xMEYSv/xe8lObsOZboFpJWiAV2eHV0ShGlABZM';

export async function verifyLogin(email: string, password: string): Promise<AdminUser | null> {
  const row = findAdminByEmail(email.toLowerCase().trim());
  // A no-password account (created via the Cloud handoff) can't be logged into
  // with a password until one is set — treat it like an unknown email, and burn
  // the same argon2 time so it isn't distinguishable by timing.
  if (!row || !row.password_hash) {
    await argon2.verify(DUMMY_HASH_FOR_TIMING, password);
    return null;
  }
  const ok = await argon2.verify(row.password_hash, password);
  if (!ok) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role ?? 'admin', twoFactorEnabled: !!row.two_factor_enabled, hasPassword: true };
}

export function getAdminById(id: string): AdminUser | null {
  const row = findAdminById(id);
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role ?? 'admin', twoFactorEnabled: !!row.two_factor_enabled, hasPassword: !!row.password_hash };
}

export async function createFirstAdmin(email: string, password: string, name: string): Promise<void> {
  // Don't bother hashing if it's obviously already too late — but the real
  // guarantee against concurrent setup submissions comes from the atomic
  // insert below, not this check (which has a TOCTOU gap while the hash
  // is computed).
  if (countAdminUsers() > 0) throw new Error('Admin user already exists');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const created = createFirstAdminUser(crypto.randomUUID(), email.toLowerCase().trim(), hash, name);
  if (!created) throw new Error('Admin user already exists');
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** Verifies a plaintext password against a stored admin account — used to
 *  confirm the current password before letting someone change their own. */
export async function verifyAdminPassword(id: string, password: string): Promise<boolean> {
  const row = findAdminById(id);
  if (!row) return false;
  return argon2.verify(row.password_hash, password);
}

export function adminExists(): boolean {
  return countAdminUsers() > 0;
}
