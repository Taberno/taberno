import Fastify, { type FastifyRequest, type FastifyReply, type FastifyError } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyFormbody from '@fastify/formbody';
import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifySession from '@fastify/session';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import config from './config';
import { db } from './db/connection';
import { runMigrations } from './db/migrate';
import { themeRegistry } from './theme/registry';
import { storefrontRoutes } from './routes/storefront/index';
import { cloudRoutes } from './routes/cloud';
import { adminRoutes } from './routes/admin/index';
import { ensureCart } from './commerce/cart';
import { writeLog } from './db/queries/system-log';
import { recordPageView } from './db/queries/analytics';
import { getSetting } from './db/queries/admin';
import { refreshUpdateStatus } from './admin/updates';
import { startAbandonedCartSweep } from './email/abandoned-cart';

const BOT_UA = /bot|crawler|spider|scrapy|wget|curl|python|java|ruby|go-http|httpclient|libwww|okhttp|axios|node-fetch|facebookexternalhit|twitterbot|linkedinbot|slackbot|whatsapp|telegram|discord|pingdom|uptimerobot|datadog|statuscake|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|yandex|baidu|duckduck|bingpreview|gptbot|claudebot|chatgpt/i;
const SKIP_PREFIX = ['/admin', '/public/', '/uploads/', '/webhooks', '/health'];
const SKIP_EXT   = /\.(js|css|ico|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|map)$/i;

import './types';
import { storeUrl as resolveStoreUrl } from './store-url';

async function build() {
  // trustProxy: the app runs behind Caddy, which terminates TLS and forwards
  // plain HTTP to loopback. Without this, request.protocol is 'http', and
  // @fastify/session refuses to persist a session whose cookie is marked
  // `secure` — so every login would silently fail in production. It also makes
  // request.ip the real client address rather than the proxy's, which the rate
  // limiter and analytics both depend on. Safe because HOST binds to loopback,
  // so only the proxy can reach the app and forge X-Forwarded-* headers.
  const fastify = Fastify({ logger: true, trustProxy: true });

  // ── Security headers ───────────────────────────────────────────────────────
  // SAMEORIGIN (not DENY) because the theme customiser embeds the storefront
  // preview in an iframe from the same origin — DENY would break that.
  // onSend hooks must return the payload unchanged or the response body is lost.
  fastify.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });

  // ── Plugins ────────────────────────────────────────────────────────────────
  await fastify.register(fastifyFormbody);
  await fastify.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  // global: false — only routes that opt in via config.rateLimit get limited;
  // ordinary storefront browsing is unaffected.
  await fastify.register(fastifyRateLimit, { global: false });
  await fastify.register(fastifyCookie, { secret: config.sessionSecret });
  await fastify.register(fastifySession, {
    secret: config.sessionSecret,
    cookie: { secure: config.nodeEnv === 'production', httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
    saveUninitialized: false,
  });
  await fastify.register(fastifyCsrf, {
    sessionPlugin: '@fastify/cookie',
    // @fastify/multipart's content-type parser never populates req.body — the
    // parts are only consumed lazily by req.file() inside the handler — so the
    // plugin's default body lookup can't see the {{csrf_field}} hidden input on
    // an upload form. Multipart forms therefore carry the token in the action's
    // query string instead; everything else still uses the body. The token is
    // base64url, so it needs no escaping in a URL.
    getToken: (req: FastifyRequest) => {
      const body = req.body as { _csrf?: string } | undefined;
      const query = req.query as { _csrf?: string } | undefined;
      return (
        body?._csrf ||
        query?._csrf ||
        (req.headers['csrf-token'] as string | undefined) ||
        (req.headers['x-csrf-token'] as string | undefined)
      );
    },
  });

  await fastify.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'public'),
    prefix: '/public/',
    decorateReply: false,
  });

  // Serve uploaded product images. Use config.uploadsDir (honours UPLOADS_DIR)
  // so serving matches where uploads are written, exported and imported — a
  // hardcoded cwd/uploads would 404 whenever UPLOADS_DIR points elsewhere.
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  await fastify.register(fastifyStatic, {
    root: config.uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
  });

  // ── Database ───────────────────────────────────────────────────────────────
  runMigrations();

  // ── Theme registry ─────────────────────────────────────────────────────────
  await themeRegistry.init(fastify);

  // ── Cart cookie hook ───────────────────────────────────────────────────────
  // Runs before every storefront handler; ensures req.cartId is always set.
  // Skips admin/static/webhook paths — those never need a cart, and without
  // this a cookie-less caller (bots, Stripe/PayPal webhook deliveries, plain
  // asset requests) would create a fresh, unbounded `carts` row on every hit.
  fastify.decorateRequest('cartId', '');
  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0];
    if (SKIP_PREFIX.some((p) => url.startsWith(p))) return;

    const existing = req.cookies.taberno_cart;
    const cartId = await ensureCart(existing);
    if (cartId !== existing) {
      reply.setCookie('taberno_cart', cartId, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.nodeEnv === 'production',
        maxAge: 30 * 24 * 60 * 60,
      });
    }
    req.cartId = cartId;
  });

  // ── Global error handler ───────────────────────────────────────────────────
  fastify.setErrorHandler((err: FastifyError, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    // Only 5xx are the server's fault and worth surfacing under Settings → Logs.
    // 4xx are client errors — a bot POSTing junk to a random path trips the CSRF
    // check (403 "Missing csrf secret"), a malformed request 400s, a rate limit
    // 429s — and logging those as server errors just floods the panel with
    // internet background noise. The per-request access log (stdout) still
    // records them; keep an extra breadcrumb at debug level only.
    if (statusCode >= 500) {
      writeLog('error', 'error', err.message || 'Unhandled error', {
        url: req.url,
        method: req.method,
        stack: err.stack?.split('\n').slice(0, 4).join(' | '),
        statusCode,
      });
      fastify.log.error(err);
    } else {
      fastify.log.debug({ url: req.url, method: req.method, statusCode }, err.message || 'client error');
    }
    // Full message logged above (server errors only). Only what's sent to the
    // CLIENT is redacted — an unexpected 5xx in production may otherwise leak
    // file paths, SQL fragments, or other internal detail via err.message.
    const message = statusCode >= 500 && config.nodeEnv === 'production'
      ? 'Internal Server Error'
      : err.message;
    reply.code(statusCode).send({ error: message });
  });

  // ── Analytics page-view tracking ───────────────────────────────────────────
  fastify.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'GET') return;
    const status = reply.statusCode;
    if (status < 200 || status >= 300) return;
    const url = req.url.split('?')[0];
    if (SKIP_PREFIX.some((p) => url.startsWith(p))) return;
    if (SKIP_EXT.test(url)) return;
    const ua = req.headers['user-agent'] ?? '';
    if (BOT_UA.test(ua)) return;

    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim()
      ?? req.ip ?? '0.0.0.0';
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);

    const rawRef = req.headers['referer'] ?? req.headers['referrer'] ?? '';
    let referrer: string | null = null;
    if (rawRef) {
      try {
        const refHost = new URL(rawRef as string).hostname;
        const storeUrl = resolveStoreUrl();
        const ownHost = new URL(storeUrl).hostname;
        if (refHost && refHost !== ownHost) referrer = refHost;
      } catch { /* malformed referrer — ignore */ }
    }

    recordPageView(url, referrer, ipHash);
  });

  // ── Health check ─────────────────────────────────────────────────────────
  // Liveness/readiness probe for Docker/proxies/uptime monitors. Confirms the
  // process is up AND the database is reachable. Excluded from the cart cookie
  // hook and analytics via SKIP_PREFIX so probes don't create carts or skew
  // page-view counts.
  fastify.get('/health', async (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return reply.send({ status: 'ok' });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(503).send({ status: 'error', error: 'database unavailable' });
    }
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  // No-op unless CLOUD_MODE=true.
  await cloudRoutes(fastify);
  await adminRoutes(fastify);
  await storefrontRoutes(fastify, themeRegistry);

  return fastify;
}

async function start() {
  const fastify = await build();
  try {
    await fastify.listen({ port: config.port, host: config.host });
    console.log(`\n  Taberno storefront → http://localhost:${config.port}\n`);
    // Warm the "update available" check, then refresh it hourly in the
    // background. Best-effort — never blocks startup or serving.
    refreshUpdateStatus();
    setInterval(refreshUpdateStatus, 60 * 60 * 1000).unref();
    // Recover abandoned checkouts in the background.
    startAbandonedCartSweep();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
