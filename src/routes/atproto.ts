import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSetting, setSetting } from '../db/queries/admin';
import { writeLog } from '../db/queries/system-log';
import { storeUrl, storeUrlFor } from '../store-url';
import { PATHS, completeLogin, getOAuthClient, isLoopbackUrl, storeUrlProblem } from '../atproto/oauth';
import { syncNow } from '../atproto/scheduler';

// Public endpoints atproto OAuth needs. The authorization server fetches the
// client metadata and public key without a session, and the user's browser
// returns to the callback from their PDS. The callback is only useful with a
// state value created by an admin starting sign-in (see admin/atproto.ts).
// Also the handle proof, which resolvers fetch to verify a domain handle.

export async function atprotoPublicRoutes(fastify: FastifyInstance): Promise<void> {
  const unavailable = (reply: FastifyReply) => reply.code(404).send({ error: 'NotFound' });
  const confidential = () => !isLoopbackUrl(storeUrl()) && storeUrlProblem() === null;

  // https://atproto.com/specs/handle — the HTTPS method. Plain text, read
  // straight from settings, so no theme, redirect or session is involved.
  // Fastify answers HEAD from this GET route too.
  fastify.get('/.well-known/atproto-did', async (_req, reply) => {
    reply.type('text/plain; charset=utf-8').header('access-control-allow-origin', '*');
    const did = getSetting('atproto_did');
    if (!did) return reply.code(404).send('not found');
    return reply.header('cache-control', 'public, max-age=300').send(`${did}\n`);
  });

  fastify.get(PATHS.clientMetadata, async (_req, reply) => {
    if (!confidential()) return unavailable(reply);
    const client = await getOAuthClient();
    return reply.header('cache-control', 'public, max-age=300').send(client.clientMetadata);
  });

  fastify.get(PATHS.jwks, async (_req, reply) => {
    if (!confidential()) return unavailable(reply);
    const client = await getOAuthClient();
    return reply.header('cache-control', 'public, max-age=300').send(client.jwks);
  });

  fastify.get(
    PATHS.callback,
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
      const params = new URLSearchParams(req.query);
      // Loopback sign-in returns to 127.0.0.1; send the admin back to the
      // store URL their session cookie belongs to.
      const back = (qs: string) => reply.redirect(storeUrlFor(`/admin/atproto?${qs}`));
      if (params.get('error')) {
        return back(`error=${encodeURIComponent(params.get('error_description') || params.get('error')!)}`);
      }
      try {
        const { did, handle } = await completeLogin(params);
        setSetting('atproto_enabled', '1');
        writeLog('atproto', 'info', `Connected ${handle ?? did}`, { did });
        void syncNow('connected', true);
        return back('connected=1');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeLog('atproto', 'error', `Sign-in failed: ${message}`);
        return back(`error=${encodeURIComponent(message)}`);
      }
    },
  );
}
