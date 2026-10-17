import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '../../types';
import { render } from '../../admin/render';
import { getAdminById } from '../../admin/auth';
import { getAllSettings, setSetting } from '../../db/queries/admin';
import { listLogs } from '../../db/queries/system-log';
import { canUpdateHandle, disconnect, isLoopbackUrl, restoreSession, startLogin, storeUrlProblem } from '../../atproto/oauth';
import { syncNow } from '../../atproto/scheduler';
import { checkIdentity, handleDomain, handleVerified, parseDid, useDomainHandle, type IdentityCheck } from '../../atproto/handle';
import * as state from '../../atproto/state';
import { storeUrl } from '../../store-url';

// Settings → AT Protocol: one guided flow. Create an account, connect it, use
// the store domain as its handle, publish. The page works out each step's
// state on load; the JS on it only saves a reload after the handle actions.

export async function atprotoAdminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/atproto', page);
  fastify.post('/atproto/connect', connect);
  fastify.post('/atproto/settings', saveSettings);
  fastify.post('/atproto/sync', syncHandler);
  fastify.post('/atproto/disconnect', disconnectHandler);
  fastify.post('/atproto/handle', saveHandle);
  fastify.get('/api/atproto/check', checkHandler);
  fastify.post('/api/atproto/use-domain-handle', useDomainHandleHandler);
}

const COLLECTION_LABELS: Record<string, string> = {
  'shop.lgtm.commerce.storefront': 'Storefront',
  'shop.lgtm.commerce.product': 'Products',
  'shop.lgtm.commerce.variant': 'Variants',
};

const DEFAULT_DIRECTORY = 'https://atmarket.co';

interface Steps {
  connect: { done: boolean };
  handle: { done: boolean; enabled: boolean };
  publish: { done: boolean; enabled: boolean };
}

/**
 * Step 1 is informational and always done. Steps 3 and 4 both need a working
 * session; the handle step is recommended, not required, so publishing isn't
 * held back by it. The handle step also needs a public domain to hand out.
 */
export function buildSteps(o: { connected: boolean; verified: boolean; publishing: boolean; domainUsable: boolean }): Steps {
  return {
    connect: { done: o.connected },
    handle: { done: o.connected && o.verified, enabled: o.connected && o.domainUsable },
    publish: { done: o.publishing, enabled: o.connected },
  };
}

function timeAgo(sqliteUtc: string | null | undefined, now = Date.now()): string | null {
  if (!sqliteUtc) return null;
  const then = Date.parse(`${sqliteUtc.replace(' ', 'T')}Z`);
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, Math.round((now - then) / 1000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

async function sessionState(account: state.AccountRow | null): Promise<{ connected: boolean; canUpdateHandle: boolean; error: string | null }> {
  if (!account) return { connected: false, canUpdateHandle: false, error: null };
  try {
    const session = await restoreSession();
    return { connected: true, canUpdateHandle: canUpdateHandle((await session.getTokenInfo()).scope), error: null };
  } catch (err) {
    return { connected: false, canUpdateHandle: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function servedDid(settings: Record<string, string>, account: state.AccountRow | null): string | null {
  return settings.atproto_did || account?.did || null;
}

async function page(
  req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>,
  reply: FastifyReply,
) {
  const settings = getAllSettings();
  const account = state.getAccount();
  const base = storeUrl(settings);
  const domain = handleDomain(base);
  const domainUsable = !!domain && !isLoopbackUrl(base) && storeUrlProblem(base) === null;
  const did = servedDid(settings, account);

  const [session, identity] = await Promise.all([
    sessionState(account),
    did && domain ? checkIdentity(did, domain) : Promise.resolve<IdentityCheck | null>(null),
  ]);
  const verified = handleVerified(identity, domain);
  const publishing = settings.atproto_enabled === '1';
  const steps = buildSteps({ connected: session.connected, verified, publishing, domainUsable });

  const directory = (settings.atproto_directory_url || DEFAULT_DIRECTORY).replace(/\/$/, '');
  const handle = identity?.handle ?? account?.handle ?? null;
  const counts = account ? state.recordCounts(account.did) : [];
  const lastRun = state.recentRuns(10).find((r) => r.status === 'completed');

  return reply.type('text/html').send(
    await render(
      'atproto',
      {
        admin: getAdminById(req.session.adminId!)!,
        settings,
        account,
        session,
        steps,
        domain,
        domainUsable,
        loopback: isLoopbackUrl(base),
        urlProblem: storeUrlProblem(base),
        // A connected account whose DID isn't the one being served: offer to swap.
        didConflict: !!(account && settings.atproto_did && settings.atproto_did !== account.did),
        status: {
          handle,
          did,
          verified: !!handle && !!identity?.handleResolvesToDid,
          checked: !!identity,
          products: counts.find((c) => c.collection === 'shop.lgtm.commerce.product')?.n ?? null,
          lastSync: timeAgo(lastRun?.finished_at),
          directoryPage: handle ? `${directory}/@${handle}` : null,
          directoryName: directory === DEFAULT_DIRECTORY ? 'Atmarket' : directory.replace(/^https?:\/\//, ''),
        },
        enabled: publishing,
        counts: counts.map((c) => ({ label: COLLECTION_LABELS[c.collection] ?? c.collection, n: c.n })),
        runs: state.recentRuns(10),
        logs: listLogs('atproto', 20),
        flash: req.query,
        pageTitle: 'AT Protocol',
        pageSection: 'atproto',
      },
      reply,
    ),
  );
}

async function connect(req: FastifyRequest<{ Body: { handle?: string } }>, reply: FastifyReply) {
  const handle = req.body.handle?.trim();
  if (!handle) return reply.redirect('/admin/atproto?error=Enter%20your%20handle');
  try {
    return reply.redirect((await startLogin(handle)).toString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.redirect(`/admin/atproto?error=${encodeURIComponent(message)}`);
  }
}

async function saveSettings(req: FastifyRequest<{ Body: { enabled?: string; directory_url?: string } }>, reply: FastifyReply) {
  const enabled = req.body.enabled === '1';
  setSetting('atproto_enabled', enabled ? '1' : '0');
  const dir = req.body.directory_url?.trim();
  if (dir && /^https?:\/\//.test(dir)) setSetting('atproto_directory_url', dir);
  if (enabled && state.getAccount()) void syncNow('enabled', true);
  return reply.redirect('/admin/atproto?saved=1#step-publish');
}

async function syncHandler(_req: FastifyRequest, reply: FastifyReply) {
  if (!state.getAccount()) return reply.redirect('/admin/atproto?error=Connect%20an%20account%20first');
  void syncNow('manual', true);
  return reply.redirect('/admin/atproto?syncing=1');
}

async function disconnectHandler(_req: FastifyRequest, reply: FastifyReply) {
  await disconnect();
  setSetting('atproto_enabled', '0');
  return reply.redirect('/admin/atproto?disconnected=1');
}

async function saveHandle(req: FastifyRequest<{ Body: { did?: string } }>, reply: FastifyReply) {
  const input = req.body.did?.trim() ?? '';
  // Empty clears it, and /.well-known/atproto-did goes back to 404.
  if (input === '') {
    setSetting('atproto_did', '');
    return reply.redirect('/admin/atproto?handle=cleared#step-handle');
  }
  const parsed = parseDid(input);
  if ('error' in parsed) return reply.redirect(`/admin/atproto?error=${encodeURIComponent(parsed.error)}#step-handle`);
  setSetting('atproto_did', parsed.did);
  return reply.redirect('/admin/atproto?handle=saved#step-handle');
}

async function checkHandler(_req: FastifyRequest, reply: FastifyReply) {
  const did = servedDid(getAllSettings(), state.getAccount());
  const domain = handleDomain();
  const empty = { did, handle: null, handleResolvesToDid: false, wellKnownServesDid: false, pdsEndpoint: null };
  if (!did) return reply.send({ ...empty, error: 'No DID saved yet.' });
  if (!domain) return reply.send({ ...empty, error: 'The store URL in Settings is not a valid URL.' });
  return reply.send(await checkIdentity(did, domain));
}

/** JSON for the page's fetch(), a redirect with a flash for the plain form. */
async function useDomainHandleHandler(req: FastifyRequest, reply: FastifyReply) {
  const json = (req.headers.accept ?? '').includes('application/json');
  const fail = (status: number, error: string, needsReauth = false) =>
    json
      ? reply.code(status).send({ ok: false, error, ...(needsReauth ? { needsReauth: true } : {}) })
      : reply.redirect(`/admin/atproto?${needsReauth ? 'reauth=1&' : ''}error=${encodeURIComponent(error)}#step-handle`);

  const base = storeUrl();
  const domain = handleDomain(base);
  if (!domain || isLoopbackUrl(base) || storeUrlProblem(base)) {
    return fail(422, 'Set a public https store URL in Settings first: that domain becomes the handle.');
  }
  if (!state.getAccount()) return fail(400, 'Connect an account first.');
  let session;
  try {
    session = await restoreSession();
  } catch (err) {
    return fail(409, err instanceof Error ? err.message : String(err), true);
  }
  // Nothing saved yet (connected before this existed): serve this account's DID.
  if (!getAllSettings().atproto_did) setSetting('atproto_did', session.did);

  const result = await useDomainHandle(session, domain);
  if (!result.body.ok) return fail(result.status, result.body.error, !!result.body.needsReauth);
  if (result.body.verified) state.saveAccount(session.did, domain);
  return json
    ? reply.send(result.body)
    : reply.redirect(`/admin/atproto?handle_result=${result.body.verified ? 'verified' : 'pending'}#step-handle`);
}
