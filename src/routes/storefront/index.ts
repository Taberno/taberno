import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ThemeRegistry } from '../../theme/registry';
import { buildGlobalContext } from '../../theme/context';
import { getProduct, listProducts, searchProducts, getCartRecommendations } from '../../commerce/products';
import { listPublishedReviews, getRatingSummary, createReview } from '../../db/queries/reviews';
import { getCollectionPage, listCollections, listFeaturedProducts } from '../../commerce/collections';
import { getCartSummary, getCartPage, addToCart, updateCartItem, removeFromCart } from '../../commerce/cart';
import { setCartDiscount, clearCartDiscount } from '../../db/queries/cart';
import { findDiscountByCode } from '../../db/queries/discounts';
import { validateDiscount, type DiscountValidation } from '../../commerce/discounts';
import { findAllPages, findPageBySlug, getHomepage, isHomepage, type PageRow } from '../../db/queries/pages';
import { getProductSectionsRaw } from '../../db/queries/products';
import { getCollectionSectionsRaw } from '../../db/queries/collections';
import { findPublishedPosts, countPublishedPosts, findPublishedPostBySlug } from '../../db/queries/posts';
import { getAllSettings, getSetting } from '../../db/queries/admin';
import { resolveSections } from '../../commerce/section-render';
import { addSuppression } from '../../db/queries/suppressions';
import { verifyUnsubscribeToken } from '../../email/unsubscribe';
import { addSubscriber, unsubscribeEmail } from '../../db/queries/newsletter';
import { CURRENCY_SYMBOLS } from '../../theme/context';
import { checkoutRoutes } from './checkout';
import { accountRoutes } from './account';
import { downloadRoutes } from './downloads';
import { feedRoutes } from './feed';
import { findCustomerById } from '../../db/queries/customers';
import { storeUrl as resolveStoreUrl } from '../../store-url';
import { getGroupForCustomer } from '../../db/queries/customer-groups';
import { findRedirect, bumpRedirectHits, normalizeRedirectPath, isProtectedRedirectPath } from '../../db/queries/redirects';

/**
 * Resolves the 301 target for a request, or null if there's no redirect. Called
 * only where real content has already missed (a 404 branch), or for a legacy
 * `/?…` link that our routes ignore — so a redirect never shadows a live page.
 * Bumps the hit count on a match. One indexed query; skipped for protected
 * system paths. The caller performs the redirect (`return reply.redirect(...)`).
 */
function redirectTarget(req: FastifyRequest): string | null {
  const qIndex = req.url.indexOf('?');
  const rawPath = qIndex === -1 ? req.url : req.url.slice(0, qIndex);
  const rawQuery = qIndex === -1 ? '' : req.url.slice(qIndex + 1);
  const path = normalizeRedirectPath(rawPath);
  if (isProtectedRedirectPath(path)) return null;

  // Candidate keys: the path itself, and — for legacy `/?p=<id>` links — the
  // query form. Woo's query permalinks live at the root, so build `/?<query>`.
  const candidates = rawQuery ? [path, `/?${rawQuery}`] : [path];
  const redirect = findRedirect(candidates);
  if (!redirect || redirect.to_path === path) return null;

  bumpRedirectHits(redirect.id);
  return redirect.to_path;
}

// Shown on the homepage when the theme's value-props haven't been customised.
// Kept in sync with the manifest default in themes/linen/theme.json.
const DEFAULT_VALUE_PROPS = [
  { title: 'Free Shipping',   body: 'On all orders over $50', icon: 'truck' },
  { title: '30-Day Returns',  body: 'Hassle-free returns',    icon: 'returns' },
  { title: 'Secure Checkout', body: 'SSL encrypted payments', icon: 'lock' },
];

function discountErrorMessage(v: Extract<DiscountValidation, { ok: false }>): string {
  const symbol = CURRENCY_SYMBOLS[getAllSettings().store_currency ?? 'GBP'] ?? '';
  switch (v.reason) {
    case 'inactive':     return 'That code is no longer active.';
    case 'expired':      return 'That code has expired.';
    case 'usage_limit':  return 'That code has reached its usage limit.';
    case 'min_subtotal': return `Spend at least ${symbol}${((v.minSubtotal ?? 0) / 100).toFixed(2)} to use this code.`;
    default:             return "That code isn't valid.";
  }
}

async function base(
  req: FastifyRequest,
  reply: FastifyReply,
  currentPath: string,
  registry: ThemeRegistry,
): Promise<Awaited<ReturnType<typeof buildGlobalContext>> & { csrfToken: string; cssVars: string }> {
  const cartSummary = await getCartSummary(req.cartId);
  const global = await buildGlobalContext(currentPath, registry.currentThemeConfig);
  const group = getGroupForCustomer(req.session.customerId);
  let customer = null;
  if (req.session.customerId) {
    const c = findCustomerById(req.session.customerId);
    if (c) customer = {
      loggedIn: true,
      firstName: c.first_name || null,
      group: group ? { name: group.name, discountPercent: group.discount_percent, taxDisplay: group.tax_display } : null,
    };
  }
  // A trade/wholesale group can force ex- or inc-tax price display.
  if (group?.tax_display) global.tax.displayMode = group.tax_display as 'inc' | 'ex';
  return {
    ...global,
    cart: cartSummary,
    customer,
    csrfToken: reply.generateCsrf(),
    cssVars: registry.currentCssVars,
  };
}

async function render(
  registry: ThemeRegistry,
  reply: FastifyReply,
  template: string,
  ctx: Record<string, unknown>,
): Promise<void> {
  const html = await registry.currentEngine.render(template, ctx);
  reply.type('text/html').send(html);
}

async function cartFragment(
  registry: ThemeRegistry,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const cart = await getCartPage(req.cartId, req.session.customerId ?? null);
  // `store` is required: cart-contents.hbs builds its own hx-post/hx-delete URLs
  // from {{../store.cartSlug}}. Without it the re-rendered buttons collapse to
  // "//update" and "//remove/<id>", which a browser reads as protocol-relative
  // URLs pointing at a host called "update"/"remove" — so after the first htmx
  // swap every quantity change and Remove click silently went nowhere.
  const global = await buildGlobalContext(req.url.split('?')[0], registry.currentThemeConfig);
  const html = await registry.currentEngine.render('partials/cart-contents', {
    ...global,
    cart,
    csrfToken: reply.generateCsrf(),
    cssVars: registry.currentCssVars,
  });
  reply.type('text/html');
  return html;
}

export async function storefrontRoutes(fastify: FastifyInstance, registry: ThemeRegistry): Promise<void> {
  // Enforce the CSRF token on every state-changing storefront request (cart,
  // checkout, account). Excludes /webhooks/* — Stripe/PayPal call those
  // server-to-server with no session cookie at all, verified instead by
  // signature inside checkout.ts; applying session-based CSRF there would
  // reject every legitimate webhook delivery.
  fastify.addHook('preHandler', (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return done();
    if (req.url.split('?')[0].startsWith('/webhooks/')) return done();
    // The admin live-preview endpoints are read-only (they render HTML, never
    // mutate) and are authorised by the admin session inside the handler. A
    // cross-origin forgery can't read the response, so CSRF adds nothing here —
    // exempt them like webhooks.
    if (req.url.split('?')[0].startsWith('/__preview/')) return done();
    fastify.csrfProtection(req, reply, done);
  });

  await checkoutRoutes(fastify, registry);
  await accountRoutes(fastify, registry);
  await downloadRoutes(fastify);
  await feedRoutes(fastify);

  // One-click opt-out from recovery emails (token-signed link in the email).
  fastify.get('/unsubscribe', async (req: FastifyRequest<{ Querystring: { e?: string; t?: string } }>, reply: FastifyReply) => {
    const email = (req.query.e ?? '').trim();
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const storeName = esc(getAllSettings().store_name || 'the store');
    const page = (msg: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6;color:#111827;"><h1 style="font-size:1.25rem;">${storeName}</h1><p>${msg}</p></body></html>`;
    if (email && verifyUnsubscribeToken(email, req.query.t)) {
      addSuppression(email);
      return reply.type('text/html').send(page(`You've been unsubscribed. <strong>${esc(email)}</strong> will no longer receive cart reminders.`));
    }
    return reply.code(400).type('text/html').send(page('This unsubscribe link is invalid or has expired.'));
  });

  // ── Newsletter ───────────────────────────────────────────────────────────────
  // Storefront footer signup. Rate-limited to blunt abuse of the open form.
  fastify.post('/newsletter/subscribe', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req: FastifyRequest<{ Body: { email?: string } }>, reply: FastifyReply) => {
      const email = (req.body?.email ?? '').trim();
      const valid = /.+@.+\..+/.test(email);
      if (valid) addSubscriber(email, 'footer');

      // htmx swaps the form out for an inline confirmation; a plain POST just
      // returns to the page the shopper came from.
      if (req.headers['hx-request']) {
        reply.type('text/html');
        return valid
          ? `<p class="newsletter-signup__done">Thanks for subscribing! You're on the list.</p>`
          : `<p class="newsletter-signup__error">Please enter a valid email address.</p>`;
      }
      const referer = (req.headers['referer'] as string | undefined) ?? '/';
      return reply.redirect(referer);
    });

  // Token-signed opt-out from newsletter broadcasts (link in every broadcast).
  fastify.get('/newsletter/unsubscribe', async (req: FastifyRequest<{ Querystring: { e?: string; t?: string } }>, reply: FastifyReply) => {
    const email = (req.query.e ?? '').trim();
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const storeName = esc(getAllSettings().store_name || 'the store');
    const page = (msg: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6;color:#111827;"><h1 style="font-size:1.25rem;">${storeName}</h1><p>${msg}</p></body></html>`;
    if (email && verifyUnsubscribeToken(email, req.query.t)) {
      unsubscribeEmail(email);
      return reply.type('text/html').send(page(`You've been unsubscribed. <strong>${esc(email)}</strong> will no longer receive our newsletter.`));
    }
    return reply.code(400).type('text/html').send(page('This unsubscribe link is invalid or has expired.'));
  });

  // The cart word (Cart/Basket/Bag) is configurable, so its URL can be any of
  // these. We register all three up front and let the templates link to
  // whichever matches the current label — so changing the word takes effect
  // immediately, with no server restart, and switching never 404s.
  const CART_SLUGS = ['cart', 'basket', 'bag'];
  const activeCartSlug = (): string => (getAllSettings().cart_label || 'Cart').toLowerCase();

  // Renders a section-built page (CMS page or the designated home page) through
  // the `page` template, resolving dynamic sections (e.g. featured_products).
  async function renderPage(
    req: FastifyRequest, reply: FastifyReply, page: PageRow, path: string,
  ): Promise<void> {
    const ctx = await base(req, reply, path, registry);
    const sections = await resolveSections(page.sections);
    await render(registry, reply, 'page', {
      ...ctx,
      pageTitle: page.seo_title || page.title,
      metaDescription: page.seo_description || page.excerpt || '',
      page: { ...page, sections },
    });
  }

  fastify.get('/', async (req, reply) => {
    // A legacy `/?p=<id>` link (Woo serves every object there) reaches the home
    // route since the router ignores the query — honour a redirect before we
    // render home. Only when a query is present, so a plain homepage hit is free.
    if (req.url.includes('?')) {
      const target = redirectTarget(req);
      if (target) return reply.redirect(target, 301);
    }

    // If a page is set as the home page, render it here; otherwise fall back to
    // the theme's default home (hero + featured product rows + value props).
    const home = getHomepage();
    if (home) return renderPage(req, reply, home, '/');

    const ctx = await base(req, reply, '/', registry);
    const layout = ctx.theme.config.layout ?? {};
    const sectionsConfig = Array.isArray(layout.featuredSections)
      ? layout.featuredSections as Array<{ title?: string; collection?: string; count?: string; sort?: string }>
      : [];
    const featuredSections = await Promise.all(sectionsConfig.map(async (section) => {
      const collectionSlug = (section.collection ?? '').trim();
      const count = parseInt(section.count ?? '', 10) || 8;
      const sort = section.sort === 'newest' ? 'newest' : 'featured';
      return {
        title: section.title?.trim() || 'Featured Products',
        collectionSlug,
        products: await listFeaturedProducts(collectionSlug, count, sort),
      };
    }));
    await render(registry, reply, 'index', {
      ...ctx,
      pageTitle: ctx.store.name,
      featuredSections,
      showHero: layout.showHero ?? true,
      heroEyebrow: layout.heroEyebrow ?? 'New Collection',
      heroHeading: layout.heroHeading ?? 'Welcome to our store',
      heroSubheading: layout.heroSubheading ?? 'Curated goods for considered living.',
      showValueProps: layout.showValueProps ?? true,
      valueProps: Array.isArray(layout.valueProps) ? layout.valueProps : DEFAULT_VALUE_PROPS,
    });
  });

  // POST /__preview/page — admin live preview: render a page from *draft*
  // sections (from the section builder) and return the HTML for an iframe.
  // Read-only + admin-gated + CSRF-exempt (see the storefront CSRF preHandler).
  fastify.post('/__preview/page', async (req, reply) => {
    if (!req.session.adminId) return reply.code(403).type('text/html').send('Forbidden');
    const body = (req.body ?? {}) as { sections?: unknown; title?: string; content?: string };
    const ctx = await base(req, reply, '/__preview', registry);
    ctx.marketing = { pixelHead: '', pixelNoscript: '' }; // don't fire pixels while previewing
    const sections = await resolveSections(body.sections);
    const html = await registry.currentEngine.render('page', {
      ...ctx,
      page: { title: body.title || '', content: body.content || '', sections },
    });
    return reply.type('text/html').send(html);
  });

  fastify.get('/products/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const [ctx, product] = await Promise.all([
      base(req, reply, `/products/${slug}`, registry),
      getProduct(slug),
    ]);
    if (!product) {
      return reply.code(404).type('text/html').send(
        await registry.currentEngine.render('404', { ...ctx, pageTitle: 'Page Not Found' }),
      );
    }
    const reviews = listPublishedReviews(product.id).map((r) => ({
      rating: r.rating, title: r.title, body: r.body, author: r.author_name,
      verified: r.verified === 1, date: r.created_at,
    }));
    const reviewSummary = getRatingSummary(product.id);
    const flash = (req.query as { review?: string }).review ?? null;

    // schema.org Product JSON-LD (with AggregateRating/Review) for search rich results.
    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.title,
      description: (product.seoDescription || product.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 500),
      image: product.images.map((i) => i.large),
      offers: {
        '@type': 'Offer',
        price: (product.price.amount / 100).toFixed(2),
        priceCurrency: ctx.store.currency.code,
        availability: product.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      },
    };
    if (reviewSummary.count > 0) {
      jsonLd.aggregateRating = { '@type': 'AggregateRating', ratingValue: reviewSummary.average, reviewCount: reviewSummary.count };
      jsonLd.review = reviews.slice(0, 5).map((r) => ({
        '@type': 'Review',
        reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5 },
        author: { '@type': 'Person', name: r.author },
        ...(r.body ? { reviewBody: r.body } : {}),
      }));
    }
    // Escape '<' so the JSON can't break out of the <script> block.
    const productJsonLd = JSON.stringify(jsonLd).replace(/</g, '\\u003c');

    // Global product-page template sections, then this product's own, rendered
    // below the product detail.
    const contentSections = [
      ...await resolveSections(getSetting('product_template_sections')),
      ...await resolveSections(getProductSectionsRaw(product.id)),
    ];
    await render(registry, reply, 'product', {
      ...ctx,
      pageTitle: product.seoTitle || product.title,
      metaDescription: product.seoDescription || product.description || '',
      ogImage: product.images[0]?.large ?? null,
      product,
      contentSections,
      reviews,
      reviewSummary,
      reviewFlash: flash,
      productJsonLd,
    });
  });

  // Submit a product review (open submission; verified-purchase badge auto-applied).
  fastify.post('/products/:slug/reviews', async (req: FastifyRequest<{ Params: { slug: string }; Body: Record<string, string> }>, reply: FastifyReply) => {
    const { slug } = req.params;
    const product = await getProduct(slug);
    if (!product) return reply.code(404).type('text/html').send('Not found');

    const b = req.body;
    const rating = parseInt(b.rating ?? '', 10);
    const authorName = (b.author_name ?? '').trim();
    const email = (b.email ?? '').trim();
    const body = (b.body ?? '').trim();
    const title = (b.title ?? '').trim() || null;
    if (!(rating >= 1 && rating <= 5) || !authorName || !/.+@.+\..+/.test(email) || !body) {
      return reply.redirect(`/products/${slug}?review=error#reviews`);
    }

    const autoPublish = getAllSettings().reviews_require_approval !== '1';
    const { status } = createReview({ productId: product.id, rating, title, body, authorName, email }, autoPublish);
    return reply.redirect(`/products/${slug}?review=${status === 'published' ? 'thanks' : 'pending'}#reviews`);
  });

  fastify.get('/collections/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const sort = (req.query as { sort?: string }).sort ?? 'featured';
    const [ctx, collection] = await Promise.all([
      base(req, reply, `/collections/${slug}`, registry),
      getCollectionPage(slug, sort),
    ]);
    if (!collection) {
      return reply.code(404).type('text/html').send(
        await registry.currentEngine.render('404', { ...ctx, pageTitle: 'Page Not Found' }),
      );
    }
    const contentSections = [
      ...await resolveSections(getSetting('collection_template_sections')),
      ...await resolveSections(getCollectionSectionsRaw(collection.id)),
    ];
    await render(registry, reply, 'collection', {
      ...ctx,
      pageTitle: collection.seoTitle || collection.title,
      metaDescription: collection.seoDescription || collection.description || '',
      collection,
      contentSections,
    });
  });

  // ── Cart page + operations ──────────────────────────────────────────────────
  const cartPage = async (req: FastifyRequest, reply: FastifyReply) => {
    const [ctx, cart] = await Promise.all([
      base(req, reply, `/${activeCartSlug()}`, registry),
      getCartPage(req.cartId, req.session.customerId ?? null),
    ]);
    const q = req.query as { error?: string; discount_error?: string };
    await render(registry, reply, 'cart', {
      ...ctx, pageTitle: `Your ${ctx.store.cartLabel}`, cart,
      recommendations: getCartRecommendations(req.cartId),
      outOfStock: q.error === 'out_of_stock',
      slotRequired: q.error === 'slot_required',
      unavailable: q.error === 'unavailable',
      discountError: q.discount_error,
    });
  };

  const cartApplyDiscount = async (req: FastifyRequest, reply: FastifyReply) => {
    const code = ((req.body as { discount?: string }).discount ?? '').trim();
    const slug = activeCartSlug();
    if (!code) return reply.redirect(`/${slug}`);
    const cart = await getCartPage(req.cartId, req.session.customerId ?? null);
    const v = validateDiscount(findDiscountByCode(code), cart.subtotal.amount);
    if (v.ok) {
      setCartDiscount(req.cartId, v.code);
      return reply.redirect(`/${slug}`);
    }
    return reply.redirect(`/${slug}?discount_error=${encodeURIComponent(discountErrorMessage(v))}`);
  };

  const cartRemoveDiscount = async (req: FastifyRequest, reply: FastifyReply) => {
    clearCartDiscount(req.cartId);
    return reply.redirect(`/${activeCartSlug()}`);
  };

  const cartAdd = async (req: FastifyRequest, reply: FastifyReply) => {
    const { variantId, quantity } = req.body as { variantId: string; quantity?: string };
    try {
      await addToCart(req.cartId, variantId, parseInt(quantity ?? '1', 10));
    } catch {
      // stock/variant errors are surfaced on the cart page itself
    }
    if (req.headers['hx-request']) {
      const { itemCount } = await getCartSummary(req.cartId);
      const badge = itemCount > 0
        ? `<span id="cart-count" class="cart-badge">${itemCount}</span>`
        : `<span id="cart-count" class="cart-badge" style="display:none"></span>`;
      reply.type('text/html');
      return badge;
    }
    return reply.redirect(`/${activeCartSlug()}`);
  };

  const cartUpdate = async (req: FastifyRequest, reply: FastifyReply) => {
    const { itemId, quantity } = req.body as { itemId: string; quantity: string };
    await updateCartItem(req.cartId, itemId, parseInt(quantity, 10));
    if (req.headers['hx-request']) return cartFragment(registry, req, reply);
    return reply.redirect(`/${activeCartSlug()}`);
  };

  const cartRemove = async (req: FastifyRequest, reply: FastifyReply) => {
    const { itemId } = req.params as { itemId: string };
    await removeFromCart(req.cartId, itemId);
    if (req.headers['hx-request']) return cartFragment(registry, req, reply);
    return reply.redirect(`/${activeCartSlug()}`);
  };

  for (const slug of CART_SLUGS) {
    fastify.get(`/${slug}`, cartPage);
    fastify.post(`/${slug}/add`, cartAdd);
    fastify.post(`/${slug}/update`, cartUpdate);
    fastify.delete(`/${slug}/remove/:itemId`, cartRemove);
    fastify.post(`/${slug}/discount`, cartApplyDiscount);
    fastify.post(`/${slug}/discount/remove`, cartRemoveDiscount);
  }

  fastify.get('/search', async (req, reply) => {
    const { q = '' } = req.query as { q?: string };
    const [ctx, products] = await Promise.all([
      base(req, reply, '/search', registry),
      q.trim() ? searchProducts(q.trim()) : Promise.resolve([]),
    ]);
    await render(registry, reply, 'search', { ...ctx, pageTitle: 'Search', query: q, products });
  });

  // Catch-all page lookup — registered last so all specific routes take priority
  // ── Blog ────────────────────────────────────────────────────────────────────
  // Registered before the '/*' page catch-all (Fastify prioritises these anyway).
  fastify.get('/blog', async (req, reply) => {
    const pageNum = Math.max(1, parseInt((req.query as { page?: string }).page ?? '1', 10));
    const limit = 9;
    const ctx = await base(req, reply, '/blog', registry);
    const posts = findPublishedPosts(limit, (pageNum - 1) * limit).map((p) => ({
      title: p.title, slug: p.slug, excerpt: p.excerpt, image: p.featured_image, author: p.author, date: p.published_at,
    }));
    const totalPages = Math.ceil(countPublishedPosts() / limit);
    await render(registry, reply, 'blog-index', {
      ...ctx, pageTitle: 'Blog', posts,
      page: pageNum, totalPages, hasPrev: pageNum > 1, hasNext: pageNum < totalPages,
      prevUrl: `/blog?page=${pageNum - 1}`, nextUrl: `/blog?page=${pageNum + 1}`,
    });
  });

  fastify.get('/blog/rss.xml', async (_req, reply) => {
    const settings = getAllSettings();
    const storeUrl = resolveStoreUrl(settings);
    const esc = (s: string | null) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const items = findPublishedPosts(50, 0).map((p) => {
      const pub = p.published_at ? `<pubDate>${new Date(p.published_at).toUTCString()}</pubDate>` : '';
      return `<item><title>${esc(p.title)}</title><link>${storeUrl}/blog/${esc(p.slug)}</link>` +
             `<guid>${storeUrl}/blog/${esc(p.slug)}</guid>${pub}<description>${esc(p.excerpt)}</description></item>`;
    }).join('');
    reply.type('application/rss+xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>` +
      `<title>${esc(settings.store_name ?? 'Blog')}</title><link>${storeUrl}/blog</link>` +
      `<description>${esc(settings.store_tagline ?? '')}</description>${items}</channel></rss>`,
    );
  });

  fastify.get('/blog/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const ctx = await base(req, reply, `/blog/${slug}`, registry);
    const post = findPublishedPostBySlug(slug);
    if (!post) {
      return reply.code(404).type('text/html').send(
        await registry.currentEngine.render('404', { ...ctx, pageTitle: 'Page Not Found' }),
      );
    }
    let sections: unknown[] = [];
    try { sections = JSON.parse(post.sections || '[]'); } catch { /* fallback */ }

    const storeUrl = resolveStoreUrl();
    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org', '@type': 'BlogPosting',
      headline: post.title,
      description: (post.seo_description || post.excerpt || '').slice(0, 500),
      ...(post.featured_image ? { image: post.featured_image } : {}),
      ...(post.published_at ? { datePublished: post.published_at } : {}),
      ...(post.author ? { author: { '@type': 'Person', name: post.author } } : {}),
      mainEntityOfPage: `${storeUrl}/blog/${post.slug}`,
    };
    const postJsonLd = JSON.stringify(jsonLd).replace(/</g, '\\u003c');

    await render(registry, reply, 'blog-post', {
      ...ctx,
      pageTitle: post.seo_title || post.title,
      metaDescription: post.seo_description || post.excerpt || '',
      ogImage: post.featured_image ?? null,
      post: { ...post, sections },
      postJsonLd,
    });
  });

  fastify.get('/*', async (req, reply) => {
    const slug = (req.params as { '*': string })['*'];
    const page = findPageBySlug(slug);
    if (!page) {
      // A real page always wins; only once it misses do we consider a redirect
      // (e.g. an imported Woo `/product/<slug>/` URL) before falling to the 404.
      const target = redirectTarget(req);
      if (target) return reply.redirect(target, 301);
      const ctx = await base(req, reply, `/${slug}`, registry);
      return reply.code(404).type('text/html').send(
        await registry.currentEngine.render('404', { ...ctx, pageTitle: 'Page Not Found' }),
      );
    }
    // The home page is canonical at "/" — send its own slug there.
    if (isHomepage(page.id)) return reply.redirect('/');
    await renderPage(req, reply, page, `/${slug}`);
  });

  fastify.get('/robots.txt', async (_req, reply) => {
    const storeUrl = resolveStoreUrl();
    reply.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${storeUrl}/sitemap.xml\n`);
  });

  fastify.get('/sitemap.xml', async (_req, reply) => {
    const storeUrl = resolveStoreUrl();
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

    const [products, collections, pages] = await Promise.all([
      listProducts(),
      listCollections(),
      Promise.resolve(findAllPages().filter(p => p.status === 'published')),
    ]);
    const posts = findPublishedPosts(1000, 0);

    const urls: string[] = [
      `<url><loc>${esc(storeUrl)}/</loc></url>`,
      `<url><loc>${esc(storeUrl)}/collections/all</loc></url>`,
      ...products.map(p => `<url><loc>${esc(storeUrl)}/products/${esc(p.slug)}</loc></url>`),
      ...collections.map(c => `<url><loc>${esc(storeUrl)}/collections/${esc(c.slug)}</loc></url>`),
      ...pages.map(p => `<url><loc>${esc(storeUrl)}/${esc(p.slug)}</loc></url>`),
      ...(posts.length ? [`<url><loc>${esc(storeUrl)}/blog</loc></url>`] : []),
      ...posts.map(p => `<url><loc>${esc(storeUrl)}/blog/${esc(p.slug)}</loc></url>`),
    ];

    return reply.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  ${urls.join('\n  ')}\n</urlset>`,
    );
  });

  fastify.setNotFoundHandler(async (req, reply) => {
    // Safety net for any path that reached here without hitting the '/*' branch.
    if (req.method === 'GET') {
      const target = redirectTarget(req);
      if (target) return reply.redirect(target, 301);
    }
    const ctx = await base(req, reply, req.url, registry);
    const html = await registry.currentEngine.render('404', { ...ctx, pageTitle: 'Page Not Found' });
    return reply.code(404).type('text/html').send(html);
  });
}
