import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import fs from 'fs';
import config from '../config';
import { queryOne } from '../db/connection';
import { countAdminUsers, findAdminByEmail, createFirstAdminUser } from '../db/queries/admin';
import { recordJtiIfUnseen, pruneExpiredJti } from '../db/queries/cloud-session';

/**
 * Endpoints for a managed (Taberno Cloud) deployment.
 *
 * Only registered when CLOUD_MODE=true, so a self-hosted install has no extra
 * surface at all — these routes simply do not exist there.
 */
export async function cloudRoutes(fastify: FastifyInstance): Promise<void> {
  if (!config.cloudMode) return;

  /**
   * Usage counts for the control plane's hourly metering sweep.
   *
   * Authenticated with X-Cloud-Secret, the shared secret the control plane
   * writes into this store's .env, compared in constant time. With no secret
   * configured the endpoint refuses everything rather than defaulting open.
   */
  fastify.get('/api/usage', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authorised(req)) return reply.code(404).send({ error: 'Not found' });

    const products = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM products');
    return reply.send({
      products: products?.n ?? 0,
      staff: countAdminUsers(),
      db_size: databaseSize(),
    });
  });

  /**
   * Single sign-on from the Taberno Cloud dashboard.
   *
   * The control plane mints a short-lived, single-use token bound to this one
   * store and redirects the customer's browser here; a valid token establishes
   * a normal admin session, so "Open admin" in their dashboard lands them
   * inside their shop instead of on a login form. See verifyHandoffToken for
   * the checks and the contract.
   *
   * GET only, token in the query string — one entry point, and never accepted
   * by POST or in a header. The URL carries a bearer token, so the response is
   * marked no-store to keep it out of any shared cache. The token, its payload
   * and the secret are never logged, at any level.
   */
  fastify.get('/admin/cloud-session', async (req: FastifyRequest<{ Querystring: { t?: string } }>, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');

    const now = Date.now();
    const payload = verifyHandoffToken(req.query.t, now);
    if (!payload) return refuseHandoff(reply);

    // Single use: record the jti, refusing if it's already spent (a replay).
    // Pruning expired records as we go is the whole of the cleanup a
    // 60-second token needs.
    pruneExpiredJti(now);
    if (!recordJtiIfUnseen(payload.jti, payload.exp)) return refuseHandoff(reply);

    const email = payload.email.toLowerCase().trim();
    let admin = findAdminByEmail(email);
    if (!admin) {
      // No account for this email. Create the owner ONLY if the store has none
      // yet — this replaces the /admin/setup step for a hosted store, with no
      // password set (they set one later from their account page). If an admin
      // already exists under a different email, refuse rather than mint a
      // second owner from a token naming an unknown address.
      if (countAdminUsers() > 0) return refuseHandoff(reply);
      const created = createFirstAdminUser(crypto.randomUUID(), email, '', payload.name?.trim() || email.split('@')[0]);
      if (!created) return refuseHandoff(reply); // lost a concurrent setup race
      admin = findAdminByEmail(email);
      if (!admin) return refuseHandoff(reply);
    }

    // Establish a normal admin session, exactly as a successful password login does.
    req.session.set('adminId', admin.id);
    return reply.redirect('/admin');
  });
}

interface HandoffPayload {
  store_id: string;
  email: string;
  name: string;
  exp: number;
  jti: string;
}

/**
 * Verifies a control-plane admin-handoff token, returning its payload or null.
 * Every failure returns null (the caller redirects to /admin/login with a
 * generic message) so nothing about which check failed leaks to a forger.
 *
 * Checks, in order:
 *   1. CLOUD_AUTH_SECRET is configured — never fall back to cloudSecret or a
 *      default; with no secret, no token can be accepted.
 *   2. The signature matches, compared in constant time (a fast reject on the
 *      first wrong byte would leak the signature a byte at a time to anyone
 *      timing it). The payload is only parsed AFTER the signature proves it ours.
 *   3. `exp` (epoch ms) is in the future — tokens are minted with a 60s life.
 *   4. `store_id` is this store's own id — belt and braces given the per-store
 *      secret, but it's the check that saves us if a secret is ever reused.
 * The remaining single-use (`jti`) check is stateful and lives in the handler.
 */
function verifyHandoffToken(token: string | undefined, now: number): HandoffPayload | null {
  const secret = config.cloudAuthSecret;
  if (!secret) return null; // (1)
  if (typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payloadPart, signaturePart] = parts;

  // (2) Constant-time signature check over the encoded payload segment.
  const expected = crypto.createHmac('sha256', secret).update(payloadPart).digest().toString('base64url');
  const provided = Buffer.from(signaturePart);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(provided, expectedBuf)) return null;

  let payload: HandoffPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as HandoffPayload;
  } catch {
    return null;
  }
  if (
    !payload || typeof payload !== 'object' ||
    typeof payload.store_id !== 'string' ||
    typeof payload.email !== 'string' ||
    typeof payload.exp !== 'number' ||
    typeof payload.jti !== 'string'
  ) {
    return null;
  }

  if (!(payload.exp > now)) return null;                             // (3)
  if (!config.storeId || payload.store_id !== config.storeId) return null; // (4)

  return payload;
}

/** Generic failure: back to the login form, never disclosing which check failed. */
function refuseHandoff(reply: FastifyReply): FastifyReply {
  reply.header('Cache-Control', 'no-store');
  return reply.redirect('/admin/login?error=cloud_session');
}

/**
 * Size of this store's SQLite database on disk, in bytes.
 *
 * Includes the -wal and -shm sidecars: in WAL mode a busy store can hold
 * megabytes of committed data in the write-ahead log that has not been
 * checkpointed back into the main file yet, and ignoring it would under-report
 * exactly when the store is busiest.
 */
function databaseSize(): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(`${config.databasePath}${suffix}`).size;
    } catch {
      // Sidecars only exist while the database is open.
    }
  }
  return total;
}

function authorised(req: FastifyRequest): boolean {
  const expected = config.cloudSecret;
  if (!expected) return false;

  const provided = req.headers['x-cloud-secret'];
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;

  // Constant time, so a wrong token cannot be recovered by measuring how long
  // the comparison took.
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
