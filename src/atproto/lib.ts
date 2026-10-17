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

interface LexiconsInstance {
  add(doc: unknown): void;
  assertValidRecord(nsid: string, value: unknown): unknown;
}

interface LexiconModule {
  Lexicons: new () => LexiconsInstance;
  jsonToLex(value: unknown): unknown;
}

let oauth: OAuthModule | null = null;
let lexicon: LexiconModule | null = null;

export function oauthLib(): OAuthModule {
  oauth ??= require('@atproto/oauth-client-node') as OAuthModule;
  return oauth;
}

export function lexiconLib(): LexiconModule {
  lexicon ??= require('@atproto/lexicon') as LexiconModule;
  return lexicon;
}
