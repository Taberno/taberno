import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '../../types';
import { render } from '../../admin/render';
import { getAdminById } from '../../admin/auth';
import { getAllSettings, setSetting } from '../../db/queries/admin';
import { listLogs } from '../../db/queries/system-log';
import { disconnect, isLoopbackUrl, startLogin, storeUrlProblem } from '../../atproto/oauth';
import { syncNow } from '../../atproto/scheduler';
import * as state from '../../atproto/state';
import { storeUrl } from '../../store-url';

// Settings → AT Protocol: connect the store's account, turn publishing on or
// off, run a sync, and see what happened.

export async function atprotoAdminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/atproto', page);
  fastify.post('/atproto/connect', connect);
  fastify.post('/atproto/settings', saveSettings);
  fastify.post('/atproto/sync', syncHandler);
  fastify.post('/atproto/disconnect', disconnectHandler);
}

const COLLECTION_LABELS: Record<string, string> = {
  'shop.lgtm.commerce.storefront': 'Storefront',
  'shop.lgtm.commerce.product': 'Products',
  'shop.lgtm.commerce.variant': 'Variants',
};

async function page(
  req: FastifyRequest<{ Querystring: { connected?: string; error?: string; saved?: string; syncing?: string; disconnected?: string } }>,
  reply: FastifyReply,
) {
  const settings = getAllSettings();
  const account = state.getAccount();
  const directory = (settings.atproto_directory_url || 'https://atmarket.co').replace(/\/$/, '');
  const base = storeUrl(settings);
  return reply.type('text/html').send(
    await render(
      'atproto',
      {
        admin: getAdminById(req.session.adminId!)!,
        settings,
        account,
        enabled: settings.atproto_enabled === '1',
        directoryUrl: directory,
        directoryPage: account ? `${directory}/m/${encodeURIComponent(account.handle ?? account.did)}` : null,
        counts: account
          ? state.recordCounts(account.did).map((c) => ({ label: COLLECTION_LABELS[c.collection] ?? c.collection, n: c.n }))
          : [],
        runs: state.recentRuns(10),
        logs: listLogs('atproto', 20),
        urlProblem: storeUrlProblem(base),
        loopback: isLoopbackUrl(base),
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
  return reply.redirect('/admin/atproto?saved=1');
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
