import dns from 'dns';
import { getSetting, setSetting } from '../db/queries/admin';
import { storeUrl } from '../store-url';
import { assertPublicHost } from '../import/woocommerce/image-fetch';
import type { OAuthSessionLike } from './lib';
import { call, XrpcError } from './repo';
import { canUpdateHandle } from './oauth';

// Domain handles: the store serves /.well-known/atproto-did with the DID in
// the `atproto_did` setting, which lets the account use the store's own domain
// as its handle (https://atproto.com/specs/handle). This file holds the
// validation, the identity check behind the admin page's status, and the
// one-click switch of the account's handle to the store domain.

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

/**
 * After sign-in, make the served DID the connected account's. Fills an empty
 * setting; a different DID already there is left for the merchant to confirm
 * replacing, since it may be deliberate.
 */
export function adoptSessionDid(did: string): 'set' | 'unchanged' | 'conflict' {
  const current = getSetting('atproto_did') || '';
  if (current === did) return 'unchanged';
  if (current !== '') return 'conflict';
  setSetting('atproto_did', did);
  return 'set';
}

// --- resolution ---------------------------------------------------------------

/** Where the DID document lives: plc.directory, or the did:web host itself. */
export function didDocumentUrl(did: string): string {
  if (did.startsWith('did:plc:')) return `https://plc.directory/${did}`;
  // did:web:host[:path:segments], with a port percent-encoded as %3A.
  const [host, ...path] = did.slice('did:web:'.length).split(':').map(decodeURIComponent);
  return path.length ? `https://${host}/${path.join('/')}/did.json` : `https://${host}/.well-known/did.json`;
}

function timeoutError(err: unknown, what: string): Error {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new Error(`Timed out fetching ${what}.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** The handle and PDS a DID document declares. */
export async function resolveDidDocument(did: string): Promise<{ handle: string | null; pdsEndpoint: string | null }> {
  const url = new URL(didDocumentUrl(did));
  // did:web points anywhere the merchant typed; don't let it reach the host's
  // own network (cloud stores share a box).
  if (did.startsWith('did:web:')) await assertPublicHost(url.hostname);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/did+ld+json, application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw timeoutError(err, 'the DID document');
  }
  if (!res.ok) throw new Error(`Could not fetch the DID document (HTTP ${res.status}).`);
  const doc = (await res.json()) as { id?: unknown; alsoKnownAs?: unknown; service?: unknown };
  if (doc.id !== did) throw new Error('The DID document returned is for a different DID.');

  const aka = Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs : [];
  const atUri = aka.find((a): a is string => typeof a === 'string' && a.startsWith('at://'));
  const services = Array.isArray(doc.service) ? (doc.service as { id?: unknown; type?: unknown; serviceEndpoint?: unknown }[]) : [];
  const pds = services.find((s) => typeof s.id === 'string' && s.id.endsWith('#atproto_pds') && s.type === 'AtprotoPersonalDataServer');
  return {
    handle: atUri ? atUri.slice('at://'.length).toLowerCase() : null,
    pdsEndpoint: typeof pds?.serviceEndpoint === 'string' ? pds.serviceEndpoint : null,
  };
}

/** The DID a domain serves at /.well-known/atproto-did, fetched over the internet. */
export async function fetchWellKnownDid(domain: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`https://${domain}/.well-known/atproto-did`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw timeoutError(err, `https://${domain}/.well-known/atproto-did`);
  }
  if (!res.ok) return null;
  const line = (await res.text()).split('\n')[0].trim();
  return line.startsWith('did:') ? line : null;
}

const resolver = new dns.promises.Resolver({ timeout: TIMEOUT_MS, tries: 1 });
let txtLookup: (name: string) => Promise<string[][]> = (name) => resolver.resolveTxt(name);

/** Tests swap in a fake DNS. */
export function setTxtLookup(fn: ((name: string) => Promise<string[][]>) | null): void {
  txtLookup = fn ?? ((name) => resolver.resolveTxt(name));
}

/** The DID a handle points at: the well-known file first, then the _atproto TXT record. */
export async function resolveHandle(handle: string): Promise<string | null> {
  try {
    await assertPublicHost(handle);
    const did = await fetchWellKnownDid(handle);
    if (did) return did;
  } catch {
    // fall through to DNS
  }
  try {
    const records = await txtLookup(`_atproto.${handle}`);
    const dids = records.map((r) => r.join('')).filter((r) => r.startsWith('did=')).map((r) => r.slice(4));
    return dids.length === 1 ? dids[0] : null; // more than one is invalid per the spec
  } catch {
    return null;
  }
}

export interface IdentityCheck {
  did: string | null;
  /** The handle the DID document claims, without at://. */
  handle: string | null;
  handleResolvesToDid: boolean;
  wellKnownServesDid: boolean;
  pdsEndpoint: string | null;
  error: string | null;
}

/**
 * Everything the admin page needs to say whether the domain handle is working.
 * Single attempts with timeouts; failures come back as `error`, never a throw.
 */
export async function checkIdentity(did: string, storeDomain: string): Promise<IdentityCheck> {
  const [doc, served] = await Promise.allSettled([resolveDidDocument(did), fetchWellKnownDid(storeDomain)]);
  const handle = doc.status === 'fulfilled' ? doc.value.handle : null;
  const resolved = handle ? await resolveHandle(handle) : null;
  const errors = [doc, served]
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
  return {
    did,
    handle,
    handleResolvesToDid: resolved === did,
    wellKnownServesDid: served.status === 'fulfilled' && served.value === did,
    pdsEndpoint: doc.status === 'fulfilled' ? doc.value.pdsEndpoint : null,
    error: errors[0] ?? null,
  };
}

/** Step 3 is done when the account's handle is the store domain and checks out. */
export function handleVerified(check: IdentityCheck | null, storeDomain: string | null): boolean {
  return !!check && !!storeDomain && check.handle === storeDomain && check.handleResolvesToDid;
}

// --- one-click handle -----------------------------------------------------------

export type UseDomainHandleResult =
  | { status: 200; body: { ok: true; handle: string; did: string; verified: boolean } }
  | { status: number; body: { ok: false; error: string; needsReauth?: true } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mapUpdateError(err: unknown, domain: string): UseDomainHandleResult {
  if (!(err instanceof XrpcError)) {
    return { status: 502, body: { ok: false, error: `Couldn't reach your account's host: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const text = `${err.error ?? ''} ${err.message}`;
  if (err.status === 429 || err.error === 'RateLimitExceeded') {
    return { status: 429, body: { ok: false, error: 'Your account\'s host is limiting handle changes right now. Wait a while and try again.' } };
  }
  if ((err.status === 401 || err.status === 403) && /scope/i.test(text)) {
    return { status: 409, body: { ok: false, needsReauth: true, error: 'Taberno needs permission to change the handle. Reconnect to grant it.' } };
  }
  if (err.error === 'HandleNotAvailable' || /already taken|not available|in use/i.test(text)) {
    return { status: 409, body: { ok: false, error: `${domain} is already the handle of another account. Change that account's handle first.` } };
  }
  if (err.error === 'InvalidHandle' || err.error === 'UnsupportedDomain' || /invalid handle|unsupported domain/i.test(text)) {
    return { status: 422, body: { ok: false, error: `Your account's host won't accept ${domain} as a handle (${err.message}).` } };
  }
  return { status: 502, body: { ok: false, error: `Your account's host refused the change: ${err.message}` } };
}

/**
 * Switches the connected account's handle to the store domain: checks the
 * permission and that the domain really serves the DID (as the PDS will),
 * asks the PDS to update the handle, then waits for it to resolve.
 */
export async function useDomainHandle(
  session: OAuthSessionLike,
  domain: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<UseDomainHandleResult> {
  const { attempts = 5, delayMs = 2000 } = opts;
  const did = session.did;

  const { scope } = await session.getTokenInfo();
  if (!canUpdateHandle(scope)) {
    return { status: 409, body: { ok: false, needsReauth: true, error: 'Taberno needs permission to change the handle. Reconnect to grant it.' } };
  }

  const url = `https://${domain}/.well-known/atproto-did`;
  const served = await fetchWellKnownDid(domain).catch(() => null);
  if (served !== did) {
    const error = served
      ? `Your domain is serving a different DID (${served}). Save ${did} as the DID, then try again.`
      : `Your domain isn't serving the DID yet — check that ${url} is reachable.`;
    return { status: 422, body: { ok: false, error } };
  }

  try {
    await call(session, 'com.atproto.identity.updateHandle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: domain }),
    });
  } catch (err) {
    return mapUpdateError(err, domain);
  }

  let verified = false;
  for (let i = 0; i < attempts && !verified; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      const res = await call<{ did?: string }>(session, 'com.atproto.identity.resolveHandle', { query: { handle: domain } });
      verified = res.did === did;
    } catch {
      // not resolvable yet
    }
  }
  return { status: 200, body: { ok: true, handle: domain, did, verified } };
}
