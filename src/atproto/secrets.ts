import crypto from 'crypto';
import config from '../config';

// Encryption at rest for atproto OAuth material (client key, tokens, DPoP
// key). The key is derived from SESSION_SECRET with HKDF, so there is no new
// secret to manage. A database moved to another install (store export/import)
// will not decrypt there; callers treat that as "reconnect needed".

const VERSION = 'v1';

function key(): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', config.sessionSecret, Buffer.alloc(0), 'taberno-atproto-v1', 32));
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Returns null if the value was encrypted under a different secret or has been altered. */
export function decrypt(value: string): string | null {
  const [version, iv, tag, ct] = value.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
