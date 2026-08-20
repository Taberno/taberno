import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '../../types';
import { verifyLogin, getAdminById, adminExists } from '../../admin/auth';
import { render } from '../../admin/render';
import { authRoutes } from './auth';
import { productRoutes } from './products';
import { collectionRoutes } from './collections';
import { pageRoutes } from './pages';
import { blockRoutes } from './blocks';
import { templateRoutes } from './templates';
import { itemSectionRoutes } from './item-sections';
import { postRoutes } from './posts';
import { orderRoutes } from './orders';
import { settingsRoutes } from './settings';
import { themeRoutes } from './themes';
import { emailRoutes } from './emails';
import { importRoutes } from './import';
import { redirectRoutes } from './redirects';
import { navigationRoutes } from './navigation';
import { usersRoutes } from './users';
import { accountRoutes } from './account';
import { customersRoutes } from './customers';
import { shippingRoutes } from './shipping';
import { taxRoutes } from './tax';
import { discountRoutes } from './discounts';
import { automaticDiscountRoutes } from './automatic-discounts';
import { bannerRoutes } from './banners';
import { reviewRoutes } from './reviews';
import { analyticsRoutes } from './analytics';
import { newsletterRoutes } from './newsletter';
import { countOrders } from '../../db/queries/orders';
import { getAllSettings } from '../../db/queries/admin';
import { queryOne } from '../../db/connection';
import { getAnalyticsSummary } from '../../db/queries/analytics';
import { getRevenueSnapshot } from '../../db/queries/sales-analytics';

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  // Auth routes don't need the guard
  await fastify.register(authRoutes, { prefix: '/admin' });

  await fastify.register(
    async (app) => {
      // Guard: every route registered in this scope requires a session.
      // Scoped via Fastify's own plugin encapsulation (not a manual req.url
      // string-prefix check) so it can't be bypassed by percent-encoding or
      // other path-normalization tricks the router itself already accounts
      // for when matching a request to a route.
      app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
        const adminId = req.session.adminId;
        const admin = adminId ? getAdminById(adminId) : null;
        if (!admin) return reply.redirect('/admin/login');
      });

      // Enforce the CSRF token on every state-changing request. Uses the
      // plugin's own callback-style signature directly (it isn't
      // promise-based) — GET/HEAD/OPTIONS never carry a body/mutate state,
      // so they're exempt.
      app.addHook('preHandler', (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return done();
        app.csrfProtection(req, reply, done);
      });

      app.get('/', dashboardHandler);
      await app.register(productRoutes);
      await app.register(collectionRoutes);
      await app.register(pageRoutes);
      await app.register(blockRoutes);
      await app.register(templateRoutes);
      await app.register(itemSectionRoutes);
      await app.register(postRoutes);
      await app.register(orderRoutes);
      await app.register(customersRoutes);
      await app.register(shippingRoutes);
      await app.register(taxRoutes);
      await app.register(discountRoutes);
      await app.register(automaticDiscountRoutes);
      await app.register(bannerRoutes);
      await app.register(reviewRoutes);
      await app.register(analyticsRoutes);
      await app.register(newsletterRoutes);
      // Every signed-in user (admin or staff) can manage their own account.
      await app.register(accountRoutes);

      // Admin-only areas: staff accounts are blocked here, again via plugin
      // encapsulation rather than string-matching the request path.
      await app.register(async (adminOnly) => {
        adminOnly.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
          const admin = getAdminById(req.session.adminId!)!;
          if (admin.role === 'staff') return reply.redirect('/admin');
        });

        await adminOnly.register(settingsRoutes);
        await adminOnly.register(themeRoutes);
        await adminOnly.register(emailRoutes);
        await adminOnly.register(importRoutes);
        await adminOnly.register(redirectRoutes);
        await adminOnly.register(navigationRoutes);
        await adminOnly.register(usersRoutes);
      });
    },
    { prefix: '/admin' },
  );
}

async function dashboardHandler(req: FastifyRequest, reply: FastifyReply) {
  const adminId = req.session.adminId!;
  const admin = getAdminById(adminId)!;
  const settings = getAllSettings();
  const orderCount = countOrders();
  const productCount = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM products')?.n ?? 0;
  const analytics = getAnalyticsSummary();
  const revenue = getRevenueSnapshot(30);

  return reply.type('text/html').send(
    await render(
      'dashboard',
      {
        admin,
        settings,
        stats: { orderCount, productCount, revenue30d: revenue.revenue, orders30d: revenue.orders },
        isEmpty: productCount === 0,
        analytics,
        pageTitle: 'Dashboard',
      },
      reply,
    ),
  );
}
