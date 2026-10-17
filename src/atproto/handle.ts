import { storeUrl } from '../store-url';
import { assertPublicHost } from '../import/woocommerce/image-fetch';

// Domain handles: the store serves /.well-known/atproto-did with the DID the
// merchant pastes in, which lets the account use the store's own domain as its
// handle (https://atproto.com/specs/handle). This file holds the validation and
// the admin-side check that the account points back at the domain.

const DID_PATTERN = /^did:(plc|web):[A-Za-z0-9._:%-]+$/;
const MAX_LENGTH = 256;
const TIMEOUT_MS = 5000;

/** The normalised DID, or an error message for the settings form. */
export function parseDid(input: string): { did: string } | { error: string } {
  const did = input.trim();
  if (did.length > MAX_LENGTH) return { error: `The DID must be at most ${MAX_LENGTH} characters.` };
  if (!DID_PATTERN.test(did)) return { error: 'That is not a valid DID. It should start with did:plc: or did:web:.' };
  return { did };
}

/** The handle the store's domain gives the account: its primary hostname. */
export function handleDomain(base: string = storeUrl()): string | null {
  try {
    return new URL(base).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Where the DID document lives: plc.directory, or the did:web host itself. */
export function didDocumentUrl(did: string): string {
  if (did.startsWith('did:plc:')) return `https://plc.directory/${did}`;
  // did:web:host[:path:segments], with a port percent-encoded as %3A.
  const [host, ...path] = did.slice('did:web:'.length).split(':').map(decodeURIComponent);
  return path.length ? `https://${host}/${path.join('/')}/did.json` : `https://${host}/.well-known/did.json`;
}

export interface HandleCheck {
  ok: boolean;
  handleMatches: boolean;
  alsoKnownAs: string[];
  error: string | null;
}

/**
 * Fetches the DID document and reports whether it claims `domain` as its
 * handle. One attempt with a timeout; every failure comes back as `error`
 * rather than a throw, since the result is shown straight to the merchant.
 */
export async function checkHandle(did: string, domain: string): Promise<HandleCheck> {
  const fail = (error: string): HandleCheck => ({ ok: false, handleMatches: false, alsoKnownAs: [], error });
  try {
    const url = new URL(didDocumentUrl(did));
    // did:web points anywhere the merchant typed; don't let it reach the
    // host's own network (cloud stores share a box).
    if (did.startsWith('did:web:')) await assertPublicHost(url.hostname);
    const res = await fetch(url, {
      headers: { accept: 'application/did+ld+json, application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return fail(`Could not fetch the DID document (HTTP ${res.status}).`);
    const doc = (await res.json()) as { id?: unknown; alsoKnownAs?: unknown };
    if (doc.id !== did) return fail('The DID document returned is for a different DID.');
    const alsoKnownAs = Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs.filter((a): a is string => typeof a === 'string') : [];
    const wanted = `at://${domain.toLowerCase()}`;
    return { ok: true, handleMatches: alsoKnownAs.some((a) => a.toLowerCase() === wanted), alsoKnownAs, error: null };
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return fail('Timed out fetching the DID document.');
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}
