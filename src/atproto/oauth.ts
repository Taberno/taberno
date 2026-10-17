import { getAllSettings } from '../db/queries/admin';
import { storeUrl } from '../store-url';
import { oauthLib, type OAuthClientLike, type OAuthSessionLike, type SimpleStore } from './lib';
import { sessionRepoClient, type RepoClient } from './repo';
import * as state from './state';

// atproto OAuth for the store's own account.
//
// On a public HTTPS store URL Taberno is a confidential client: it serves its
// client metadata and public key from /atproto/*, which gives long-lived
// sessions so the hourly sync keeps working. On localhost it is a loopback
// client (no keys, short sessions), which is what atproto allows for dev.

/**
 * Write access to the three catalogue collections and image uploads, and
 * permission to change the account's handle (for "Use my domain as handle"),
 * nothing else. Granular permissions per https://atproto.com/specs/permission;
 * the client passes these through and the PDS enforces them. A PDS too old to
 * know them would need the legacy `transition:generic`, which grants far more
 * (and still not identity changes), so it isn't requested.
 */
export const SCOPE = [
  'atproto',
  'repo:shop.lgtm.commerce.storefront',
  'repo:shop.lgtm.commerce.product',
  'repo:shop.lgtm.commerce.variant',
  'blob:image/*',
  'identity:handle',
].join(' ');

/** Whether a granted scope string allows com.atproto.identity.updateHandle. */
export function canUpdateHandle(scope: string): boolean {
  const granted = scope.split(' ');
  return granted.includes('identity:handle') || granted.includes('identity:*');
}

export const PATHS = {
  clientMetadata: '/atproto/client-metadata.json',
  jwks: '/atproto/jwks.json',
  callback: '/atproto/oauth/callback',
} as const;

const CLIENT_KEY_ID = 'taberno-1';

export class ReconnectNeeded extends Error {}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Why OAuth cannot work with this store URL, or null if it can. */
export function storeUrlProblem(url: string = storeUrl()): string | null {
  if (isLoopbackUrl(url)) return null;
  try {
    if (new URL(url).protocol !== 'https:') return 'The store URL must use https for AT Protocol sign-in.';
  } catch {
    return 'The store URL in Settings is not a valid URL.';
  }
  return null;
}

function encryptedStore<V>(kind: 'state' | 'session'): SimpleStore<V> {
  return {
    async get(key) {
      return state.getSecret<V>(kind, key);
    },
    async set(key, value) {
      state.setSecret(kind, key, value);
    },
    async del(key) {
      state.deleteSecret(kind, key);
    },
  };
}

let cached: { url: string; client: OAuthClientLike } | null = null;

export async function getOAuthClient(): Promise<OAuthClientLike> {
  const base = storeUrl();
  if (cached?.url === base) return cached.client;
  const problem = storeUrlProblem(base);
  if (problem) throw new Error(problem);

  const { NodeOAuthClient, JoseKey, buildAtprotoLoopbackClientMetadata } = oauthLib();
  const stores = { stateStore: encryptedStore('state'), sessionStore: encryptedStore('session') };
  let client: OAuthClientLike;
  if (isLoopbackUrl(base)) {
    // Loopback redirect URIs must use an IP literal, not "localhost".
    const redirect = `${base.replace('//localhost', '//127.0.0.1')}${PATHS.callback}`;
    client = new NodeOAuthClient({
      clientMetadata: buildAtprotoLoopbackClientMetadata({ scope: SCOPE, redirect_uris: [redirect] }),
      ...stores,
    });
  } else {
    let jwk = state.getSecret<Record<string, unknown>>('client_key', CLIENT_KEY_ID);
    if (!jwk) {
      const generated = await JoseKey.generate(['ES256'], CLIENT_KEY_ID);
      jwk = { ...generated.privateJwk };
      state.setSecret('client_key', CLIENT_KEY_ID, jwk);
    }
    client = new NodeOAuthClient({
      clientMetadata: {
        client_id: `${base}${PATHS.clientMetadata}`,
        client_name: getAllSettings().store_name || 'Taberno store',
        client_uri: base,
        redirect_uris: [`${base}${PATHS.callback}`],
        scope: SCOPE,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: 'ES256',
        dpop_bound_access_tokens: true,
        jwks_uri: `${base}${PATHS.jwks}`,
      },
      keyset: [await JoseKey.fromImportable(jwk, CLIENT_KEY_ID)],
      ...stores,
    });
  }
  cached = { url: base, client };
  return client;
}

/** Starts sign-in: returns the URL of the user's PDS authorization page. */
export async function startLogin(handle: string): Promise<URL> {
  const client = await getOAuthClient();
  return client.authorize(handle.trim().replace(/^@/, ''), { scope: SCOPE });
}

/** Finishes sign-in from the callback's query string and stores the account. */
export async function completeLogin(params: URLSearchParams): Promise<{ did: string; handle: string | null }> {
  const client = await getOAuthClient();
  const { session } = await client.callback(params);
  const previous = state.getAccount();
  const { handle } = await sessionRepoClient(session).describeRepo();
  // Switching accounts: sign the old one out so its tokens are not kept.
  if (previous && previous.did !== session.did) await client.revoke(previous.did).catch(() => {});
  state.saveAccount(session.did, handle);
  return { did: session.did, handle };
}

/** The connected account's OAuth session, refreshing tokens if they've expired. */
export async function restoreSession(): Promise<OAuthSessionLike> {
  const account = state.getAccount();
  if (!account) throw new ReconnectNeeded('No AT Protocol account is connected.');
  try {
    const client = await getOAuthClient();
    return await client.restore(account.did);
  } catch (err) {
    throw new ReconnectNeeded(`Reconnect needed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function repoClientForAccount(): Promise<RepoClient> {
  return sessionRepoClient(await restoreSession());
}

export async function disconnect(): Promise<void> {
  const account = state.getAccount();
  if (account) {
    try {
      await (await getOAuthClient()).revoke(account.did);
    } catch {
      // the session may already be gone; forget it locally regardless
    }
  }
  state.clearAccount();
}
