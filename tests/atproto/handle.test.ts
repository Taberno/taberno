import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyCsrf from '@fastify/csrf-protection';
import { execute } from '../../src/db/connection';
import { getSetting, setSetting } from '../../src/db/queries/admin';
import * as state from '../../src/atproto/state';
import type { OAuthSessionLike } from '../../src/atproto/lib';

// The handle checks resolve real hostnames before fetching; keep tests off the
// network but still refuse the obviously private ones.
vi.mock('../../src/import/woocommerce/image-fetch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertPublicHost: vi.fn(async (host: string) => {
    if (/^(127\.|10\.|localhost)/.test(host)) throw new Error(`Refusing to fetch from a private/internal address (${host})`);
  }),
}));
vi.mock('../../src/atproto/oauth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  restoreSession: vi.fn(),
}));

const { restoreSession } = await import('../../src/atproto/oauth');
const { atprotoPublicRoutes } = await import('../../src/routes/atproto');
const { atprotoAdminRoutes, buildSteps } = await import('../../src/routes/admin/atproto');
const { adoptSessionDid, checkIdentity, didDocumentUrl, parseDid, setTxtLookup, useDomainHandle } = await import('../../src/atproto/handle');

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const OTHER_DID = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz';
const DOMAIN = 'shop.example.com';
const FULL_SCOPE = 'atproto repo:shop.lgtm.commerce.product blob:image/* identity:handle';

// --- fakes -----------------------------------------------------------------

/** A tiny internet: DID documents on plc.directory and well-known files by host. */
function stubNet(net: { aka?: string[]; wellKnown?: Record<string, string> }) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.host === 'plc.directory') {
      return Response.json({
        id: url.pathname.slice(1),
        alsoKnownAs: net.aka ?? [],
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.net' }],
      });
    }
    if (url.pathname === '/.well-known/atproto-did' && net.wellKnown?.[url.host]) {
      return new Response(`${net.wellKnown[url.host]}\n`);
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** An OAuth session whose PDS answers XRPC calls with `xrpc`. */
function fakeSession(o: { scope?: string; xrpc?: (method: string, init?: RequestInit) => Response } = {}) {
  const calls: { method: string; body?: unknown }[] = [];
  const session: OAuthSessionLike = {
    did: DID,
    async fetchHandler(pathname, init) {
      const method = pathname.replace(/^\/xrpc\//, '').split('?')[0];
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return o.xrpc?.(method, init) ?? Response.json({});
    },
    async getTokenInfo() {
      return { scope: o.scope ?? FULL_SCOPE };
    },
    async signOut() {},
  };
  return { session, calls };
}

function connectAccount(o: { scope?: string; xrpc?: (method: string) => Response } = {}) {
  state.saveAccount(DID, 'yourshop.bsky.social');
  const fake = fakeSession(o);
  vi.mocked(restoreSession).mockResolvedValue(fake.session);
  return fake;
}

// --- apps --------------------------------------------------------------------

// The public route next to stand-ins for what follows it in server.ts: the
// storefront's theme-rendered catch-all and 404 page.
async function buildPublicApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await atprotoPublicRoutes(app);
  app.get('/*', async (_req, reply) => reply.type('text/html').send('<html>theme page</html>'));
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).type('text/html').send('<html>theme 404</html>'));
  await app.ready();
  return app;
}

let adminId = '';

// The admin routes with the plugins render() needs, signed in, without the
// guard hooks index.ts wraps them in.
async function buildAdminApp(): Promise<FastifyInstance> {
  const secret = 'test-session-secret-at-least-32-characters-long';
  const app = Fastify();
  await app.register(fastifyFormbody);
  await app.register(fastifyCookie, { secret });
  await app.register(fastifySession, { secret, cookie: { secure: false } });
  await app.register(fastifyCsrf, { sessionPlugin: '@fastify/cookie' });
  app.addHook('preHandler', async (req) => {
    req.session.adminId = adminId;
  });
  await app.register(atprotoAdminRoutes, { prefix: '/admin' });
  await app.ready();
  return app;
}

const json = { accept: 'application/json' };

beforeAll(() => {
  adminId = 'admin-handle-test';
  execute(`INSERT OR IGNORE INTO admin_users (id, email, password_hash, name, role) VALUES (?, 'a@example.com', 'x', 'A', 'admin')`, [adminId]);
});

beforeEach(() => {
  state.clearAccount();
  setSetting('atproto_did', '');
  setSetting('atproto_enabled', '0');
  setSetting('store_url', `https://${DOMAIN}`);
  vi.mocked(restoreSession).mockReset().mockRejectedValue(new Error('No AT Protocol account is connected.'));
  setTxtLookup(async () => []);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setTxtLookup(null);
});

// --- tests -------------------------------------------------------------------

describe('/.well-known/atproto-did', () => {
  it('is a plain-text 404 when no DID is set, not the theme 404', async () => {
    const app = await buildPublicApp();
    const res = await app.inject('/.well-known/atproto-did');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toBe('not found');
  });

  it('serves the DID and a newline, with cache and CORS headers', async () => {
    setSetting('atproto_did', DID);
    const app = await buildPublicApp();
    const res = await app.inject('/.well-known/atproto-did');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(`${DID}\n`);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('answers HEAD with the same headers and no body', async () => {
    setSetting('atproto_did', DID);
    const app = await buildPublicApp();
    const res = await app.inject({ method: 'HEAD', url: '/.well-known/atproto-did' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toBe('');
  });
});

describe('parseDid', () => {
  it('accepts plc and web DIDs, trimmed', () => {
    expect(parseDid(`  ${DID}\n`)).toEqual({ did: DID });
    expect(parseDid('did:web:example.com')).toEqual({ did: 'did:web:example.com' });
    expect(parseDid('did:web:example.com%3A8443:shops:one')).toEqual({ did: 'did:web:example.com%3A8443:shops:one' });
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'did:', 'did:plc:', 'did:key:z6Mk', 'DID:plc:abc', 'shop.example.com', 'did:plc:abc def', 'did:plc:abc/../x', '<script>', `did:plc:${'a'.repeat(250)}`]) {
      expect(parseDid(bad), bad).toHaveProperty('error');
    }
  });

  it('finds the DID document for plc and web DIDs', () => {
    expect(didDocumentUrl(DID)).toBe(`https://plc.directory/${DID}`);
    expect(didDocumentUrl('did:web:example.com')).toBe('https://example.com/.well-known/did.json');
    expect(didDocumentUrl('did:web:example.com%3A8443:u:alice')).toBe('https://example.com:8443/u/alice/did.json');
  });
});

describe('saving the DID by hand', () => {
  it('stores a valid DID and serves it', async () => {
    const admin = await buildAdminApp();
    const res = await admin.inject({ method: 'POST', url: '/admin/atproto/handle', payload: { did: ` ${DID} ` } });
    expect(res.headers.location).toBe('/admin/atproto?handle=saved#step-handle');
    expect((await (await buildPublicApp()).inject('/.well-known/atproto-did')).body).toBe(`${DID}\n`);
  });

  it('refuses garbage and keeps the previous value', async () => {
    setSetting('atproto_did', DID);
    const admin = await buildAdminApp();
    const res = await admin.inject({ method: 'POST', url: '/admin/atproto/handle', payload: { did: 'not a did' } });
    expect(res.headers.location).toMatch(/^\/admin\/atproto\?error=/);
    expect(getSetting('atproto_did')).toBe(DID);
  });

  it('clears it when emptied', async () => {
    setSetting('atproto_did', DID);
    const admin = await buildAdminApp();
    await admin.inject({ method: 'POST', url: '/admin/atproto/handle', payload: { did: '' } });
    expect((await (await buildPublicApp()).inject('/.well-known/atproto-did')).statusCode).toBe(404);
  });
});

describe('DID on connect', () => {
  it('fills an empty DID with the connected account', () => {
    expect(adoptSessionDid(DID)).toBe('set');
    expect(getSetting('atproto_did')).toBe(DID);
    expect(adoptSessionDid(DID)).toBe('unchanged');
  });

  it('keeps a different saved DID until the merchant confirms replacing it', async () => {
    setSetting('atproto_did', OTHER_DID);
    expect(adoptSessionDid(DID)).toBe('conflict');
    expect(getSetting('atproto_did')).toBe(OTHER_DID);

    connectAccount();
    stubNet({});
    const admin = await buildAdminApp();
    const page = await admin.inject('/admin/atproto');
    expect(page.body).toContain("Use this account's DID");

    // The confirm button posts the account's DID to the normal save.
    await admin.inject({ method: 'POST', url: '/admin/atproto/handle', payload: { did: DID } });
    expect(getSetting('atproto_did')).toBe(DID);
  });
});

describe('step gating', () => {
  const fieldset = (html: string, step: string) => html.match(new RegExp(`<fieldset data-step="${step}"[^>]*>`))![0];

  it('disables the handle and publish steps without a session', async () => {
    const admin = await buildAdminApp();
    const html = (await admin.inject('/admin/atproto')).body;
    expect(fieldset(html, 'handle')).toContain('disabled');
    expect(fieldset(html, 'publish')).toContain('disabled');
  });

  it('disables them when the saved account has no working session', async () => {
    state.saveAccount(DID, 'yourshop.bsky.social'); // restoreSession still rejects
    const admin = await buildAdminApp();
    const html = (await admin.inject('/admin/atproto')).body;
    expect(fieldset(html, 'handle')).toContain('disabled');
    expect(fieldset(html, 'publish')).toContain('disabled');
    expect(html).toContain('Reconnect');
  });

  it('enables them once connected, and ticks the handle step when it verifies', async () => {
    connectAccount();
    setSetting('atproto_did', DID);
    stubNet({ aka: [`at://${DOMAIN}`], wellKnown: { [DOMAIN]: DID } });
    const admin = await buildAdminApp();
    const html = (await admin.inject('/admin/atproto')).body;
    expect(fieldset(html, 'handle')).not.toContain('disabled');
    expect(fieldset(html, 'publish')).not.toContain('disabled');
    expect(html).toContain('✓ handle verified');
    expect(html).toContain(`href="https://atmarket.co/@${DOMAIN}"`);
  });

  it('works out the steps from the session, handle and toggle', () => {
    expect(buildSteps({ connected: false, verified: true, publishing: true, domainUsable: true })).toEqual({
      connect: { done: false },
      handle: { done: false, enabled: false },
      publish: { done: true, enabled: false },
    });
    expect(buildSteps({ connected: true, verified: false, publishing: false, domainUsable: false }).handle).toEqual({ done: false, enabled: false });
    expect(buildSteps({ connected: true, verified: true, publishing: false, domainUsable: true }).handle).toEqual({ done: true, enabled: true });
  });
});

describe('GET /admin/api/atproto/check', () => {
  async function check() {
    setSetting('atproto_did', DID);
    return (await (await buildAdminApp()).inject({ url: '/admin/api/atproto/check', headers: json })).json();
  }

  it('handle resolves, well-known serves', async () => {
    stubNet({ aka: [`at://${DOMAIN}`], wellKnown: { [DOMAIN]: DID } });
    expect(await check()).toEqual({
      did: DID, handle: DOMAIN, handleResolvesToDid: true, wellKnownServesDid: true, pdsEndpoint: 'https://pds.example.net', error: null,
    });
  });

  it('handle resolves (by DNS), well-known does not serve', async () => {
    stubNet({ aka: ['at://elsewhere.example.net'], wellKnown: { [DOMAIN]: OTHER_DID } });
    setTxtLookup(async (name) => (name === '_atproto.elsewhere.example.net' ? [[`did=${DID}`]] : []));
    expect(await check()).toMatchObject({ handle: 'elsewhere.example.net', handleResolvesToDid: true, wellKnownServesDid: false });
  });

  it('handle does not resolve, well-known serves', async () => {
    stubNet({ aka: ['at://yourshop.bsky.social'], wellKnown: { [DOMAIN]: DID, 'yourshop.bsky.social': OTHER_DID } });
    expect(await check()).toMatchObject({ handle: 'yourshop.bsky.social', handleResolvesToDid: false, wellKnownServesDid: true });
  });

  it('neither', async () => {
    stubNet({ aka: [] });
    expect(await check()).toMatchObject({ handle: null, handleResolvesToDid: false, wellKnownServesDid: false, error: null });
  });

  it('reports a failed lookup as an error instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await check()).toMatchObject({ handle: null, handleResolvesToDid: false, wellKnownServesDid: false, error: 'fetch failed' });
  });

  it('refuses a did:web on the local network', async () => {
    const fetchMock = stubNet({});
    const res = await checkIdentity('did:web:127.0.0.1%3A3000', DOMAIN);
    expect(res.error).toMatch(/private/);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('127.0.0.1'))).toBe(false);
  });
});

describe('POST /admin/api/atproto/use-domain-handle', () => {
  const post = async (headers: Record<string, string> = json) =>
    (await buildAdminApp()).inject({ method: 'POST', url: '/admin/api/atproto/use-domain-handle', headers });

  it('asks for a reconnect when the session lacks the handle permission', async () => {
    connectAccount({ scope: 'atproto repo:shop.lgtm.commerce.product' });
    stubNet({ wellKnown: { [DOMAIN]: DID } });
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, needsReauth: true });
  });

  it('redirects with the reconnect prompt for the plain form', async () => {
    connectAccount({ scope: 'atproto' });
    stubNet({ wellKnown: { [DOMAIN]: DID } });
    const res = await post({});
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/admin\/atproto\?reauth=1&error=/);
  });

  it('refuses when the domain is not serving the DID', async () => {
    const { calls } = connectAccount();
    stubNet({ wellKnown: { [DOMAIN]: OTHER_DID } });
    const res = await post();
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('different DID');
    expect(calls).toHaveLength(0);

    stubNet({});
    const missing = await post();
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toBe(`Your domain isn't serving the DID yet — check that https://${DOMAIN}/.well-known/atproto-did is reachable.`);
  });

  it('updates the handle and waits for it to resolve', async () => {
    const { calls } = connectAccount({
      xrpc: (method) => (method === 'com.atproto.identity.resolveHandle' ? Response.json({ did: DID }) : Response.json({})),
    });
    stubNet({ wellKnown: { [DOMAIN]: DID } });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, handle: DOMAIN, did: DID, verified: true });
    expect(calls[0]).toEqual({ method: 'com.atproto.identity.updateHandle', body: { handle: DOMAIN } });
    expect(state.getAccount()?.handle).toBe(DOMAIN);
    expect(getSetting('atproto_did')).toBe(DID); // filled in for an account connected before it existed
  });

  it('polls resolveHandle up to five times, then reports it unverified', async () => {
    const { session, calls } = fakeSession({
      xrpc: (method) => (method === 'com.atproto.identity.resolveHandle' ? Response.json({ error: 'HandleNotFound' }, { status: 400 }) : Response.json({})),
    });
    stubNet({ wellKnown: { [DOMAIN]: DID } });
    const res = await useDomainHandle(session, DOMAIN, { delayMs: 0 });
    expect(res.body).toEqual({ ok: true, handle: DOMAIN, did: DID, verified: false });
    expect(calls.filter((c) => c.method === 'com.atproto.identity.resolveHandle')).toHaveLength(5);
  });

  it('explains a handle that is already taken', async () => {
    connectAccount({
      xrpc: () => Response.json({ error: 'InvalidRequest', message: `Handle already taken: ${DOMAIN}` }, { status: 400 }),
    });
    stubNet({ wellKnown: { [DOMAIN]: DID } });
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: `${DOMAIN} is already the handle of another account. Change that account's handle first.` });
  });

  it('explains rate limits and invalid handles', async () => {
    stubNet({ wellKnown: { [DOMAIN]: DID } });
    const limited = fakeSession({ xrpc: () => Response.json({ error: 'RateLimitExceeded', message: 'slow down' }, { status: 429 }) });
    expect((await useDomainHandle(limited.session, DOMAIN)).status).toBe(429);
    const invalid = fakeSession({ xrpc: () => Response.json({ error: 'InvalidHandle', message: 'Invalid handle' }, { status: 400 }) });
    const res = await useDomainHandle(invalid.session, DOMAIN);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ ok: false, error: expect.stringContaining("won't accept") });
  });
});
