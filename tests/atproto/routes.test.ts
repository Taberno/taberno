import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// The public OAuth endpoints. config reads STORE_URL at import, so each app is
// built from freshly imported modules under its own environment.

async function buildApp(storeUrl: string | undefined): Promise<FastifyInstance> {
  const previous = { ...process.env };
  if (storeUrl === undefined) delete process.env.STORE_URL;
  else process.env.STORE_URL = storeUrl;
  const { vi } = await import('vitest');
  vi.resetModules();
  const { atprotoPublicRoutes } = await import('../../src/routes/atproto');
  const app = Fastify();
  await atprotoPublicRoutes(app);
  await app.ready();
  process.env = previous;
  return app;
}

describe('atproto public routes', () => {
  it('serves confidential client metadata and a public key on an https store', async () => {
    const app = await buildApp('https://shop.example.com');
    const meta = await app.inject('/atproto/client-metadata.json');
    expect(meta.statusCode).toBe(200);
    const body = meta.json();
    expect(body).toMatchObject({
      client_id: 'https://shop.example.com/atproto/client-metadata.json',
      redirect_uris: ['https://shop.example.com/atproto/oauth/callback'],
      token_endpoint_auth_method: 'private_key_jwt',
      dpop_bound_access_tokens: true,
      jwks_uri: 'https://shop.example.com/atproto/jwks.json',
    });
    expect(body.scope).toBe('atproto repo:shop.lgtm.commerce.storefront repo:shop.lgtm.commerce.product repo:shop.lgtm.commerce.variant blob:image/* identity:handle');

    const jwks = (await app.inject('/atproto/jwks.json')).json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', kid: 'taberno-1' });
    expect(jwks.keys[0].d).toBeUndefined(); // never the private part

    // The key persists: a fresh process serves the same one.
    const again = await buildApp('https://shop.example.com');
    expect((await again.inject('/atproto/jwks.json')).json().keys[0].x).toBe(jwks.keys[0].x);
  });

  it('has no client metadata on localhost, where it is a loopback client', async () => {
    const app = await buildApp('http://localhost:3000');
    expect((await app.inject('/atproto/client-metadata.json')).statusCode).toBe(404);
  });

  it('sends a denied sign-in back to the admin page with the reason', async () => {
    const app = await buildApp('https://shop.example.com');
    const res = await app.inject('/atproto/oauth/callback?error=access_denied&error_description=User%20declined');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://shop.example.com/admin/atproto?error=User%20declined');
  });

  it('rejects a callback with a state it did not issue', async () => {
    const app = await buildApp('https://shop.example.com');
    const res = await app.inject('/atproto/oauth/callback?code=abc&state=forged&iss=https%3A%2F%2Fbsky.social');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/shop\.example\.com\/admin\/atproto\?error=/);
  });
});
