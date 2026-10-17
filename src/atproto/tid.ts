import crypto from 'crypto';

// atproto record keys: a TID is 64 bits (53-bit microsecond timestamp, 10-bit
// clock id) written as 13 characters of sortable base32.
// https://atproto.com/specs/tid

const CHARS = '234567abcdefghijklmnopqrstuvwxyz';
const clockId = crypto.randomInt(0, 1024);
let last = 0;

export function nextTid(nowMs: number = Date.now()): string {
  // Strictly increasing within this process, even for calls in the same microsecond.
  const micros = Math.max(nowMs * 1000, last + 1);
  last = micros;
  let n = (BigInt(micros) << 10n) | BigInt(clockId);
  let out = '';
  for (let i = 0; i < 13; i++) {
    out = CHARS[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

export function isTid(s: string): boolean {
  return /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(s);
}
