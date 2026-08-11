import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import crypto, { randomUUID } from 'crypto';
import { execute, queryOne } from '../../src/db/connection';

const SECRET = 'a-shared-cloud-secret';
const AUTH_SECRET = 'a-per-store-auth-secret-distinct-from-cloud-secret';
const STORE_ID = 'store-abc123';
// @fastify/session refuses a secret shorter than 32 characters.
const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';

/**
 * Builds an app with only the cloud routes mounted.
 *
 * config.ts reads process.env once at import, so the module is re-imported per
 * test with vi.resetModules to exercise both the on and off states.
 */
/**
 * Applies an environment overlay, deleting keys explicitly set to undefined.
 *
 * `process.env.FOO = undefined` stores the STRING "undefined", which is truthy
 * and would make "unset" tests silently assert the wrong thing.
 */
function applyEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function buildApp(env: Record<string, string | undefined>): Promise<FastifyInstance> {
  const previous = { ...process.env };
  applyEnv(env);

  const { vi } = await import('vitest');
  vi.resetModules();
  const { cloudRoutes } = await import('../../src/routes/cloud');

  const app = Fastify();
  await cloudRoutes(app);
  await app.ready();

  process.env = previous;
  return app;
}

/**
 * Builds an app with the cloud routes AND session/cookie plugins, so the
 * handoff endpoint (which establishes an admin session) can be exercised end to
 * end. Same env-overlay + resetModules dance as buildApp.
 */
async function buildSsoApp(env: Record<string, string | undefined>): Promise<FastifyInstance> {
  const previous = { ...process.env };
  applyEnv(env);

  const { vi } = await import('vitest');
  vi.resetModules();
  const fastifyCookie = (await import('@fastify/cookie')).default;
  const fastifySession = (await import('@fastify/session')).default;
  const { cloudRoutes } = await import('../../src/routes/cloud');

  const app = Fastify();
  await app.register(fastifyCookie, { secret: TEST_SESSION_SECRET });
  await app.register(fastifySession, {
    secret: TEST_SESSION_SECRET,
    cookie: { secure: false },
    saveUninitialized: false,
  });
  await cloudRoutes(app);
  await app.ready();

  process.env = previous;
  return app;
}

/** Mints a `<payload>.<signature>` handoff token exactly as the control plane does. */
function mintToken(secret: string, payload: Record<string, unknown>): string {
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
  return `${payloadPart}.${signature}`;
}

function handoffPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { store_id: STORE_ID, email: 'owner@x.test', name: 'Jane Smith', exp: Date.now() + 60_000, jti: randomUUID(), ...over };
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  execute('DELETE FROM products');
  execute('DELETE FROM admin_users');
  execute('DELETE FROM cloud_session_jti');
});

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('GET /api/usage', () => {
  it('is not registered at all unless CLOUD_MODE is on', async () => {
    app = await buildApp({ CLOUD_MODE: undefined, CLOUD_SECRET: SECRET });

    // A self-hosted install gets no extra surface whatsoever.
    const res = await app.inject({
      method: 'GET', url: '/api/usage', headers: { 'x-cloud-secret': SECRET },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns product and staff counts with a valid token', async () => {
    app = await buildApp({ CLOUD_MODE: 'true', CLOUD_SECRET: SECRET });

    execute("INSERT INTO products (id, title, slug) VALUES ('p1', 'One', 'one')");
    execute("INSERT INTO products (id, title, slug) VALUES ('p2', 'Two', 'two')");
    execute("INSERT INTO admin_users (id, email, password_hash, name) VALUES ('a1', 'a@x.test', 'h', 'A')");

    const res = await app.inject({
      method: 'GET', url: '/api/usage', headers: { 'x-cloud-secret': SECRET },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ products: 2, staff: 1 });
    // Reported so the control plane can meter storage without reaching into
    // the tenant's files itself.
    expect(res.json().db_size).toBeGreaterThan(0);
  });

  it('accepts the legacy CLOUD_INTERNAL_TOKEN name', async () => {
    // A store provisioned before the rename keeps reporting usage until its
    // .env is refreshed.
    app = await buildApp({ CLOUD_MODE: 'true', CLOUD_SECRET: undefined, CLOUD_INTERNAL_TOKEN: SECRET });

    const res = await app.inject({
      method: 'GET', url: '/api/usage', headers: { 'x-cloud-secret': SECRET },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a wrong secret', async () => {
    app = await buildApp({ CLOUD_MODE: 'true', CLOUD_SECRET: SECRET });

    const res = await app.inject({
      method: 'GET', url: '/api/usage', headers: { 'x-cloud-secret': 'not-the-token' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a request with no token', async () => {
    app = await buildApp({ CLOUD_MODE: 'true', CLOUD_SECRET: SECRET });

    const res = await app.inject({ method: 'GET', url: '/api/usage' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses everything when no token is configured, rather than defaulting open', async () => {
    app = await buildApp({ CLOUD_MODE: 'true', CLOUD_SECRET: '' });

    const res = await app.inject({
      method: 'GET', url: '/api/usage', headers: { 'x-cloud-secret': '' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('reports zero for an empty store', async () => {
    app = await buildApp({ CLOUD_MODE: 'true', CLOUD_SECRET: SECRET });

    const res = await app.inject({
      method: 'GET', url: '/api/usage', headers: { 'x-cloud-secret': SECRET },
    });
    expect(res.json()).toMatchObject({ products: 0, staff: 0 });
  });
});

describe('GET /admin/cloud-session', () => {
  const cloudEnv = { CLOUD_MODE: 'true', CLOUD_AUTH_SECRET: AUTH_SECRET, STORE_ID };

  it('does not exist unless CLOUD_MODE is on', async () => {
    app = await buildSsoApp({ ...cloudEnv, CLOUD_MODE: undefined });
    const token = mintToken(AUTH_SECRET, handoffPayload());
    const res = await app.inject({ method: 'GET', url: `/admin/cloud-session?t=${token}` });
    expect(res.statusCode).toBe(404);
  });

  it('signs in a valid token and lands on /admin, creating the owner when none exists', async () => {
    app = await buildSsoApp(cloudEnv);
    const token = mintToken(AUTH_SECRET, handoffPayload({ email: 'owner@x.test', name: 'Jane Smith' }));

    const res = await app.inject({ method: 'GET', url: `/admin/cloud-session?t=${token}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/admin');
    expect(res.headers['set-cookie']).toBeTruthy();          // a session was established
    expect(res.headers['cache-control']).toContain('no-store'); // token URL kept out of shared caches

    // The owner was created, with role admin and NO password set.
    const row = queryOne<{ email: string; role: string; password_hash: string }>(
      'SELECT email, role, password_hash FROM admin_users WHERE email = ?', ['owner@x.test'],
    );
    expect(row).toMatchObject({ email: 'owner@x.test', role: 'admin', password_hash: '' });
  });

  it('is single use — the same token fails the second time', async () => {
    app = await buildSsoApp(cloudEnv);
    const token = mintToken(AUTH_SECRET, handoffPayload());

    const first = await app.inject({ method: 'GET', url: `/admin/cloud-session?t=${token}` });
    expect(first.headers.location).toBe('/admin');

    const second = await app.inject({ method: 'GET', url: `/admin/cloud-session?t=${token}` });
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toBe('/admin/login?error=cloud_session');
  });

  it('rejects an expired token', async () => {
    app = await buildSsoApp(cloudEnv);
    const token = mintToken(AUTH_SECRET, handoffPayload({ exp: Date.now() - 1000 }));
    const res = await app.inject({ method: 'GET', url: `/admin/cloud-session?t=${token}` });
    expect(res.headers.location).toBe('/admin/login?error=cloud_session');
  });

  it('rejects a token whose payload was edited after signing (signature mismatch)', async () => {
    app = await buildSsoApp(cloudEnv);
    // Sign for one email, then swap in a different email keeping the signature.
    const signed = mintToken(AUTH_SECRET, handoffPayload({ email: 'owner@x.test' }));
    const signature = signed.split('.')[1];
    const forgedPayload = Buffer.from(JSON.stringify(handoffPayload({ email: 'attacker@x.test' }))).toString('base64url');
    const forged = `${forgedPayload}.${signature}`;

    const res = await app.inject({ method: 'GET', url: `/admin/cloud-session?t=${forged}` });
    expect(res.headers.location).toBe('/admin/login?error=cloud_session');
    expect(queryOne('SELECT 1 AS n FROM admin_users', [])).toBeNull(); // no account created
  });

  it("rejects a token minted for another store's id", async () => {
    app = await buildSsoApp(cloudEnv);
    const token = mintToken(AUTH_SECRET, handoffPayload({ store_id: 'store-someone-else' }));
    const res = await app.inject({ method: 'GET', url: `/admin/cloud-session?t=${token}` });
    expect(res.headers.location).toBe('/admin/login?error=cloud_session');
  });

  it('refuses everything when CLOUD_AUTH_SECRET is unset, never falling back to CLOUD_SECRET', async () => {
    // Route exists (CLOUD_MODE on) but no per-store auth secret is configured.
    app = await buildSsoApp({ CLOUD_MODE: 'true', CLOUD_AUTH_SECRET: undefined, CLOUD_SECRET: SECRET, STORE_ID });
    // Even a token signed with the shared CLOUD_SECRET must not be accepted.
    const token = mintToken(SECRET, handoffPayload());
    const res = await app.inject({ method: 'GET', url: `/admin/cloud-session?t=${token}` });
    expect(res.headers.location).toBe('/admin/login?error=cloud_session');
  });

  it('signs in an existing admin with the matching email without creating another', async () => {
    app = await buildSsoApp(cloudEnv);
    execute("INSERT INTO admin_users (id, email, password_hash, name, role) VALUES ('a1', 'owner@x.test', 'existing-hash', 'Owner', 'admin')");
    const token = mintToken(AUTH_SECRET, handoffPayload({ email: 'owner@x.test' }));

    const res = await app.inject({ method: 'GET', url: `/admin/cloud-session?t=${token}` });
    expect(res.headers.location).toBe('/admin');
    expect(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM admin_users', [])?.n).toBe(1);
    // The existing password is untouched — the handoff never overwrites it.
    expect(queryOne<{ password_hash: string }>('SELECT password_hash FROM admin_users WHERE email = ?', ['owner@x.test'])?.password_hash)
      .toBe('existing-hash');
  });

  it('refuses when a DIFFERENT admin already exists (unknown email)', async () => {
    app = await buildSsoApp(cloudEnv);
    execute("INSERT INTO admin_users (id, email, password_hash, name, role) VALUES ('a1', 'someone@x.test', 'h', 'Someone', 'admin')");
    const token = mintToken(AUTH_SECRET, handoffPayload({ email: 'stranger@x.test' }));

    const res = await app.inject({ method: 'GET', url: `/admin/cloud-session?t=${token}` });
    expect(res.headers.location).toBe('/admin/login?error=cloud_session');
    // No second owner minted from a token naming an unknown address.
    expect(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM admin_users', [])?.n).toBe(1);
  });

  it('accepts the token only by GET query — not as a POST', async () => {
    app = await buildSsoApp(cloudEnv);
    const token = mintToken(AUTH_SECRET, handoffPayload());
    const res = await app.inject({ method: 'POST', url: '/admin/cloud-session', payload: { t: token } });
    expect(res.statusCode).toBe(404); // no POST route
  });
});
