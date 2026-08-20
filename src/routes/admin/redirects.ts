import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '../../types';
import { render } from '../../admin/render';
import { getAdminById } from '../../admin/auth';
import { getAllSettings } from '../../db/queries/admin';
import { listRedirects, addManualRedirect, deleteRedirect } from '../../db/queries/redirects';

export async function redirectRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/redirects', redirectsPage);
  fastify.post('/redirects', addRedirect);
  fastify.post('/redirects/:id/delete', removeRedirect);
}

async function redirectsPage(
  req: FastifyRequest<{ Querystring: { added?: string; error?: string } }>,
  reply: FastifyReply,
) {
  const admin = getAdminById(req.session.adminId!)!;
  const redirects = listRedirects();
  return reply.type('text/html').send(
    await render('redirects', {
      admin,
      settings: getAllSettings(),
      redirects,
      total: redirects.length,
      added: req.query.added === '1',
      error: req.query.error,
      pageTitle: 'Redirects',
      pageSection: 'settings', // lives under Settings in the nav
    }, reply),
  );
}

async function addRedirect(
  req: FastifyRequest<{ Body: { from_path?: string; to_path?: string } }>,
  reply: FastifyReply,
) {
  const result = addManualRedirect(req.body.from_path ?? '', req.body.to_path ?? '');
  if (!result.ok) return reply.redirect(`/admin/redirects?error=${encodeURIComponent(result.error)}`);
  return reply.redirect('/admin/redirects?added=1');
}

async function removeRedirect(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  deleteRedirect(req.params.id);
  return reply.redirect('/admin/redirects');
}
