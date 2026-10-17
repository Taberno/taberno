import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import { setSetting } from '../../src/db/queries/admin';
import { atprotoPublicRoutes } from '../../src/routes/atproto';
import { atprotoAdminRoutes } from '../../src/routes/admin/atproto';
import { checkHandle, didDocumentUrl, parseDid } from '../../src/atproto/handle';

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';

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

// The admin routes without the session guard index.ts wraps them in.
async function buildAdminApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(fastifyFormbody);
  await app.register(atprotoAdminRoutes, { prefix: '/admin' });
  await app.ready();
  return app;
}

function didDocument(alsoKnownAs: string[]) {
  return new Response(JSON.stringify({ id: DID, alsoKnownAs }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  setSetting('atproto_did', '');
  setSetting('store_url', 'https://shop.example.com');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
});

describe('saving the DID', () => {
  it('stores a valid DID and serves it', async () => {
    const admin = await buildAdminApp();
    const res = await admin.inject({ method: 'POST', url: '/admin/atproto/handle', payload: { did: ` ${DID} ` } });
    expect(res.headers.location).toBe('/admin/atproto?handle=saved');
    const app = await buildPublicApp();
    expect((await app.inject('/.well-known/atproto-did')).body).toBe(`${DID}\n`);
  });

  it('refuses garbage and keeps the previous value', async () => {
    setSetting('atproto_did', DID);
    const admin = await buildAdminApp();
    const res = await admin.inject({ method: 'POST', url: '/admin/atproto/handle', payload: { did: 'not a did' } });
    expect(res.headers.location).toMatch(/^\/admin\/atproto\?error=/);
    const app = await buildPublicApp();
    expect((await app.inject('/.well-known/atproto-did')).body).toBe(`${DID}\n`);
  });

  it('clears it when emptied', async () => {
    setSetting('atproto_did', DID);
    const admin = await buildAdminApp();
    await admin.inject({ method: 'POST', url: '/admin/atproto/handle', payload: { did: '' } });
    const app = await buildPublicApp();
    expect((await app.inject('/.well-known/atproto-did')).statusCode).toBe(404);
  });
});

describe('handle check', () => {
  it('finds the DID document for plc and web DIDs', () => {
    expect(didDocumentUrl(DID)).toBe(`https://plc.directory/${DID}`);
    expect(didDocumentUrl('did:web:example.com')).toBe('https://example.com/.well-known/did.json');
    expect(didDocumentUrl('did:web:example.com%3A8443:u:alice')).toBe('https://example.com:8443/u/alice/did.json');
  });

  it('matches when alsoKnownAs claims the store domain', async () => {
    const fetchMock = vi.fn(async () => didDocument(['at://Shop.Example.com']));
    vi.stubGlobal('fetch', fetchMock);
    setSetting('atproto_did', DID);
    const admin = await buildAdminApp();
    const res = await admin.inject('/admin/api/atproto/check');
    expect(res.json()).toEqual({ ok: true, handleMatches: true, alsoKnownAs: ['at://Shop.Example.com'], error: null });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`https://plc.directory/${DID}`);
  });

  it('reports a mismatch when the account has a different handle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => didDocument(['at://someone.bsky.social'])));
    setSetting('atproto_did', DID);
    const admin = await buildAdminApp();
    const res = await admin.inject('/admin/api/atproto/check');
    expect(res.json()).toEqual({ ok: true, handleMatches: false, alsoKnownAs: ['at://someone.bsky.social'], error: null });
  });

  it('returns failures as an error instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await checkHandle(DID, 'shop.example.com')).toEqual({ ok: false, handleMatches: false, alsoKnownAs: [], error: 'fetch failed' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    expect((await checkHandle(DID, 'shop.example.com')).error).toMatch(/HTTP 404/);
  });

  it('refuses a did:web that points at the local network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await checkHandle('did:web:127.0.0.1%3A3000', 'shop.example.com');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so when no DID is saved', async () => {
    const admin = await buildAdminApp();
    expect((await admin.inject('/admin/api/atproto/check')).json()).toMatchObject({ ok: false, error: 'No DID saved yet.' });
  });
});
