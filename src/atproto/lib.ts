// The @atproto packages are ESM-only. Taberno compiles to CommonJS with
// moduleResolution "node", which cannot see their type declarations, so they
// are loaded with require() (Node >= 22.12 can require ESM) and the small
// surface used here is typed by hand. Keep it narrow: everything else talks
// to the PDS through RepoClient (repo.ts).

export interface SimpleStore<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  del(key: string): Promise<void>;
}

export interface OAuthSessionLike {
  readonly did: string;
  fetchHandler(pathname: string, init?: RequestInit): Promise<Response>;
  getTokenInfo(refresh?: boolean | 'auto'): Promise<{ scope: string }>;
  signOut(): Promise<void>;
}

export interface OAuthClientLike {
  readonly clientMetadata: Record<string, unknown>;
  readonly jwks: unknown;
  authorize(input: string, options?: { scope?: string }): Promise<URL>;
  callback(params: URLSearchParams): Promise<{ session: OAuthSessionLike }>;
  restore(did: string, refresh?: boolean | 'auto'): Promise<OAuthSessionLike>;
  revoke(did: string): Promise<void>;
}

export interface JoseKeyLike {
  readonly privateJwk?: Readonly<Record<string, unknown>>;
}

interface OAuthModule {
  NodeOAuthClient: new (options: Record<string, unknown>) => OAuthClientLike;
  JoseKey: {
    generate(algs?: string[], kid?: string): Promise<JoseKeyLike>;
    fromImportable(input: unknown, kid?: string): Promise<JoseKeyLike>;
  };
  buildAtprotoLoopbackClientMetadata(config: { scope?: string; redirect_uris?: string[] }): Record<string, unknown>;
}

export interface CommerceReport {
  ok: boolean;
  errors: { uri: string | null; message: string }[];
  warnings: { uri: string | null; message: string }[];
  counts: { products: number; variants: number; listed: number; invalid: number };
  listings: { uri: string; name: string; url: string | null; prices: Record<string, [number, number]> }[];
}

/** @atmarket/commerce-lexicons: the shop.lgtm.commerce schema and conformance check shared with directories. */
interface CommerceModule {
  validateRecord(collection: string, record: unknown): { ok: true } | { ok: false; error: string };
  checkRepo(input: { did: string | null; records: { collection: string; rkey: string; value: Record<string, unknown> }[] }): CommerceReport;
}

let oauth: OAuthModule | null = null;
let commerce: CommerceModule | null = null;

export function oauthLib(): OAuthModule {
  oauth ??= require('@atproto/oauth-client-node') as OAuthModule;
  return oauth;
}

export function commerceLib(): CommerceModule {
  commerce ??= require('@atmarket/commerce-lexicons') as CommerceModule;
  return commerce;
}
