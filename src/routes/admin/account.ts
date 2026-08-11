import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '../../types';
import { render } from '../../admin/render';
import { getAdminById, hashPassword, verifyAdminPassword } from '../../admin/auth';
import { getAllSettings, updateAdminProfile, updateAdminPassword, setAdminTwoFactor } from '../../db/queries/admin';
import { newChallenge, codeMatches, isExpired, sendLoginCode, emailConfigured, MAX_ATTEMPTS } from '../../admin/two-factor';

export async function accountRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/account', accountPage);
  fastify.post('/account/profile', saveProfile);
  fastify.post('/account/password', changePassword);
  fastify.post('/account/2fa/enable', enable2faStart);
  fastify.get('/account/2fa/confirm', confirm2faPage);
  fastify.post('/account/2fa/confirm', confirm2fa);
  fastify.post('/account/2fa/disable', disable2fa);
}

async function accountPage(
  req: FastifyRequest<{ Querystring: { saved?: string; pw?: string; error?: string } }>,
  reply: FastifyReply,
) {
  const admin = getAdminById(req.session.adminId!)!;
  const q = req.query as Record<string, string>;
  return reply.type('text/html').send(
    await render('account', {
      admin,
      settings: getAllSettings(),
      profileSaved: req.query.saved === '1',
      passwordSaved: req.query.pw === '1',
      error: req.query.error,
      twoFactorEnabled: admin.twoFactorEnabled,
      emailConfigured: emailConfigured(),
      twoFactorEnabledMsg: q['2fa'] === 'enabled',
      twoFactorDisabledMsg: q['2fa'] === 'disabled',
      pageTitle: 'My account',
      pageSection: 'account',
    }, reply),
  );
}

async function saveProfile(
  req: FastifyRequest<{ Body: { name?: string; email?: string } }>,
  reply: FastifyReply,
) {
  const name = req.body.name?.trim();
  const email = req.body.email?.toLowerCase().trim();
  if (!name || !email) return reply.redirect('/admin/account?error=missing_fields');

  try {
    updateAdminProfile(req.session.adminId!, name, email);
  } catch {
    // UNIQUE(email) — the address belongs to another user
    return reply.redirect('/admin/account?error=email_taken');
  }
  return reply.redirect('/admin/account?saved=1');
}

async function changePassword(
  req: FastifyRequest<{ Body: { current?: string; password?: string; confirm?: string } }>,
  reply: FastifyReply,
) {
  const admin = getAdminById(req.session.adminId!)!;
  const { current, password, confirm } = req.body;
  if (!password || !confirm) return reply.redirect('/admin/account?error=missing_fields');
  if (password.length < 8) return reply.redirect('/admin/account?error=too_short');
  if (password !== confirm) return reply.redirect('/admin/account?error=mismatch');

  // A Cloud-handoff account has no password yet, so there's no current one to
  // confirm — it sets an initial password here. An account that already has a
  // password must still re-authenticate before changing it.
  if (admin.hasPassword) {
    if (!current || !(await verifyAdminPassword(req.session.adminId!, current))) {
      return reply.redirect('/admin/account?error=wrong_password');
    }
  }

  updateAdminPassword(req.session.adminId!, await hashPassword(password));
  return reply.redirect('/admin/account?pw=1');
}

// ── Two-factor enable / disable ───────────────────────────────────────────────

async function enable2faStart(req: FastifyRequest, reply: FastifyReply) {
  const admin = getAdminById(req.session.adminId!)!;
  if (admin.twoFactorEnabled) return reply.redirect('/admin/account');
  // Require a working email provider first — otherwise the login code can't be
  // delivered and the account would lock itself out.
  if (!emailConfigured()) return reply.redirect('/admin/account?error=email_required');

  const { code, challenge } = newChallenge(admin.id);
  req.session.pending2faEnable = challenge;
  // Enabling is gated on entering this code — proving email delivery works
  // before 2FA is switched on.
  sendLoginCode(admin.email, admin.name, code).catch(() => {});
  return reply.redirect('/admin/account/2fa/confirm');
}

async function confirm2faPage(req: FastifyRequest<{ Querystring: { error?: string } }>, reply: FastifyReply) {
  if (!req.session.pending2faEnable) return reply.redirect('/admin/account');
  const admin = getAdminById(req.session.adminId!)!;
  return reply.type('text/html').send(
    await render('account-2fa-confirm', {
      admin, settings: getAllSettings(),
      error: req.query.error === 'invalid' ? 'That code is incorrect. Try again.' : undefined,
      pageTitle: 'Confirm two-factor', pageSection: 'account',
    }, reply),
  );
}

async function confirm2fa(req: FastifyRequest<{ Body: { code?: string } }>, reply: FastifyReply) {
  const ch = req.session.pending2faEnable;
  if (!ch || isExpired(ch.expiresAt) || ch.attempts >= MAX_ATTEMPTS) {
    delete req.session.pending2faEnable;
    return reply.redirect('/admin/account?error=2fa_failed');
  }
  const code = (req.body.code ?? '').trim();
  if (!code || !codeMatches(code, ch.codeHash)) {
    ch.attempts += 1;
    req.session.pending2faEnable = ch;
    if (ch.attempts >= MAX_ATTEMPTS) {
      delete req.session.pending2faEnable;
      return reply.redirect('/admin/account?error=2fa_failed');
    }
    return reply.redirect('/admin/account/2fa/confirm?error=invalid');
  }
  setAdminTwoFactor(req.session.adminId!, true);
  delete req.session.pending2faEnable;
  return reply.redirect('/admin/account?2fa=enabled');
}

async function disable2fa(req: FastifyRequest<{ Body: { password?: string } }>, reply: FastifyReply) {
  // Re-authenticate with the password before turning protection off.
  const password = req.body.password ?? '';
  if (!password || !(await verifyAdminPassword(req.session.adminId!, password))) {
    return reply.redirect('/admin/account?error=wrong_password');
  }
  setAdminTwoFactor(req.session.adminId!, false);
  return reply.redirect('/admin/account?2fa=disabled');
}
