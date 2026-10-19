import { commerceLib } from './lib';

// Checks records against the shop.lgtm.commerce lexicons before they leave
// the store, so a mapping bug shows up in the sync log rather than as a
// record directories silently refuse to index. The schema comes from
// @atmarket/commerce-lexicons, the same package directories validate with.

/** Returns null when valid, else the validation error. */
export function validateRecord(collection: string, record: Record<string, unknown>): string | null {
  const res = commerceLib().validateRecord(collection, record);
  return res.ok ? null : res.error;
}
