import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '../../types';
import { verifyLogin, getAdminById, createFirstAdmin, adminExists } from '../../admin/auth';
import { renderAuth } from '../../admin/render';
import { newChallenge, codeMatches, isExpired, sendLoginCode, MAX_ATTEMPTS } from '../../admin/two-factor';
import config from '../../config';

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return done();
    fastify.csrfProtection(req, reply, done);
  });

  const loginRateLimit = { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } };

  fastify.get('/login', loginPage);
  fastify.post('/login', loginRateLimit, loginSubmit);
  fastify.get('/2fa', twoFactorPage);
  fastify.post('/2fa', loginRateLimit, twoFactorVerify);
  fastify.post('/2fa/resend', { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } }, twoFactorResend);
  fastify.post('/logout', logout);
  fastify.get('/setup', setupPage);
  fastify.post('/setup', loginRateLimit, setupSubmit);
}

async function loginPage(
  req: FastifyRequest<{ Querystring: { error?: string; setup?: string } }>,
  reply: FastifyReply,
) {
  if (!adminExists()) return reply.redirect('/admin/setup');
  // Deliberately generic — a failed Squaark Cloud handoff must never reveal
  // which check it tripped, or the message becomes a guide to forging a token.
  const messages: Record<string, string> = {
    cloud_session: 'That sign-in link is invalid or has expired. Please sign in.',
  };
  return reply.type('text/html').send(await renderAuth('login', {
    pageTitle: 'Sign in',
    error: req.query.error ? messages[req.query.error] : undefined,
    setup: req.query.setup === '1',
  }, reply));
}

async function loginSubmit(
  req: FastifyRequest<{ Body: { email: string; password: string } }>,
  reply: FastifyReply,
) {
  const { email, password } = req.body;
  const admin = await verifyLogin(email, password);
  if (!admin) {
    return reply.type('text/html').send(
      await renderAuth('login', { pageTitle: 'Sign in', error: 'Invalid email or password' }, reply),
    );
  }

  // Password is correct. If the account has 2FA on, hold off setting the
  // session until the emailed code is confirmed — the challenge only starts
  // AFTER a valid password, so it never reveals whether an email has 2FA.
  if (admin.twoFactorEnabled) {
    const { code, challenge } = newChallenge(admin.id);
    req.session.pending2fa = challenge;
    delete req.session.adminId;
    sendLoginCode(admin.email, admin.name, code).catch(() => { /* resend covers a transient failure */ });
    return reply.redirect('/admin/2fa');
  }

  req.session.set('adminId', admin.id);
  return reply.redirect('/admin');
}

async function twoFactorPage(req: FastifyRequest<{ Querystring: { error?: string } }>, reply: FastifyReply) {
  if (!req.session.pending2fa) return reply.redirect('/admin/login');
  const errors: Record<string, string> = {
    invalid: 'That code is incorrect. Check your email and try again.',
    resent: '',
  };
  return reply.type('text/html').send(
    await renderAuth('2fa', {
      pageTitle: 'Enter your code',
      error: req.query.error && req.query.error !== 'resent' ? errors[req.query.error] : undefined,
      resent: req.query.error === 'resent',
    }, reply),
  );
}

async function twoFactorVerify(req: FastifyRequest<{ Body: { code?: string } }>, reply: FastifyReply) {
  const ch = req.session.pending2fa;
  if (!ch || isExpired(ch.expiresAt)) {
    delete req.session.pending2fa;
    return reply.redirect('/admin/login?error=expired');
  }
  if (ch.attempts >= MAX_ATTEMPTS) {
    delete req.session.pending2fa;
    return reply.redirect('/admin/login?error=too_many');
  }

  const code = (req.body.code ?? '').trim();
  if (!code || !codeMatches(code, ch.codeHash)) {
    ch.attempts += 1;
    req.session.pending2fa = ch; // persist the incremented attempt count
    if (ch.attempts >= MAX_ATTEMPTS) {
      delete req.session.pending2fa;
      return reply.redirect('/admin/login?error=too_many');
    }
    return reply.redirect('/admin/2fa?error=invalid');
  }

  // Correct — complete the login and burn the challenge (single-use).
  req.session.set('adminId', ch.adminId);
  delete req.session.pending2fa;
  return reply.redirect('/admin');
}

async function twoFactorResend(req: FastifyRequest, reply: FastifyReply) {
  const ch = req.session.pending2fa;
  if (!ch) return reply.redirect('/admin/login');
  const admin = getAdminById(ch.adminId);
  if (!admin) { delete req.session.pending2fa; return reply.redirect('/admin/login'); }
  const { code, challenge } = newChallenge(admin.id);
  req.session.pending2fa = challenge;
  sendLoginCode(admin.email, admin.name, code).catch(() => {});
  return reply.redirect('/admin/2fa?error=resent');
}

async function logout(req: FastifyRequest, reply: FastifyReply) {
  await req.session.destroy();
  return reply.redirect('/admin/login');
}

async function setupPage(req: FastifyRequest, reply: FastifyReply) {
  if (adminExists()) return reply.redirect('/admin/login');

  // On managed hosting everything except the login itself is already
  // configured, so this is not a first-run wizard — it is one form, pre-filled
  // with the account that bought the store.
  return reply.type('text/html').send(await renderAuth('setup', {
    pageTitle: config.cloudMode ? 'Create your login' : 'Create admin account',
    values: config.cloudMode
      ? { email: config.cloudOwnerEmail, name: config.cloudOwnerName }
      : undefined,
  }, reply));
}

async function setupSubmit(
  req: FastifyRequest<{ Body: { email: string; password: string; name: string } }>,
  reply: FastifyReply,
) {
  if (adminExists()) return reply.redirect('/admin/login');
  const { email, password, name } = req.body;

  if (!email || !password || password.length < 8) {
    return reply.type('text/html').send(
      await renderAuth('setup', {
        pageTitle: 'Create admin account',
        error: 'Email and password (min 8 chars) are required',
        values: { email, name },
      }, reply),
    );
  }

  try {
    await createFirstAdmin(email, password, name || email.split('@')[0]);
  } catch {
    // Someone else's concurrent setup submission won the race — not an error
    // from this requester's point of view, setup is simply already done.
    return reply.redirect('/admin/login');
  }
  return reply.redirect('/admin/login?setup=1');
}
