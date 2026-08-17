# Taberno Theme Engine — Technical Specification

*As-built reference — v2.0, July 2026*

*Philosophy: Handlebars everywhere. No SPA. Ship fast.*

This document describes the system as it actually exists today, for engineers extending the platform or building themes against it. It supersedes the original v1.0 planning spec — which described an earlier, unbuilt design (wrong product/theme names, a Postgres-flavoured schema, GraphQL, Redis, a CLI, and a phased implementation plan) — none of which shipped in this form. See [README.md](README.md) for the operator-facing quick start.

## 1. Guiding Principles

**One template engine.** Handlebars renders the storefront and the admin. No React, no SPA, no separate frontend build for the admin panel.

**Progressive enhancement with htmx.** The admin and storefront use htmx (loaded from a CDN `<script>` tag, not bundled) for dynamic interactions — add to cart, update quantities, live theme preview. Pages work without JavaScript; htmx enhances them. Alpine.js is included the same way for the handful of cases htmx alone is awkward (the admin page-section builder, dropdowns).

**SQLite does the heavy lifting.** One file, no separate database server. Product search is a straightforward `LIKE` query — there's no FTS5 virtual table or ranked full-text search in the current implementation, despite that being an original goal.

**Fewer services = easier self-hosting.** The entire platform is one Node.js process and one SQLite file. No Redis, no job queue, no search service.

**REST only.** No GraphQL API exists.

**Images are resized on upload, not on demand.** Three preset sizes (thumbnail, medium, large) plus a re-encoded original, all WebP. No URL-based transform service.

## 2. Tech Stack

| Component | Technology |
| --- | --- |
| Runtime | Node.js 22+ (`better-sqlite3` requires it as of v13). 22 (LTS) is the tested baseline — CI, Docker, `.nvmrc` all pin it. Native deps ship N-API prebuilt binaries, so newer versions work too — see [README.md](README.md#requirements) |
| Web framework | Fastify 4 |
| Language | TypeScript, compiled with `tsc` (no bundler) |
| Database | better-sqlite3 (synchronous SQLite driver) — the only required external dependency |
| Templates | Handlebars 4 (storefront + admin), one isolated `Handlebars.create()` instance per active theme |
| Interactivity | htmx 2.x + Alpine.js 3.x, both loaded via CDN `<script>` tags — not npm packages, not bundled |
| CSS | Plain hand-authored CSS with custom properties in the bundled `linen` theme (`themes/linen/assets/style.css`). The admin panel loads Tailwind from the `cdn.tailwindcss.com` runtime script — there is no Tailwind build pipeline, and a `tailwind.config.js` / `tailwindcss` lockfile entry are dead leftovers from an earlier build-based setup |
| Image processing | sharp — resize on upload to preset sizes, output WebP |
| Email | Nodemailer, pluggable transport (console/Resend/SMTP), Handlebars templates |
| Payments | Stripe SDK (Checkout Sessions + webhooks) and raw PayPal REST calls (no PayPal SDK) — both can be active simultaneously |
| Sessions | `@fastify/session` + `@fastify/cookie`, in-memory session store (not SQLite-backed) |
| Password hashing | argon2 (argon2id) |
| Background jobs | None. WordPress imports run inline against an `import_jobs` progress row polled by the browser; there is no queue |
| CLI | None. Everything is an npm script (`dev`, `start`, `build`, `db:migrate`, `db:seed`) |
| Testing | None currently — no test files, no test runner configured |

## 3. Project Structure

```
src/
├── server.ts               # Fastify setup, plugin registration, migrations-on-boot, analytics hook
├── config.ts                # Env vars, defaults
├── types.ts
├── db/
│   ├── connection.ts         # better-sqlite3 connection + query/execute helpers
│   ├── migrate.ts            # Applies pending src/db/migrations/*.sql on every boot
│   ├── migrations/           # 21 SQL migration files, see Section 12
│   ├── seed.ts
│   └── queries/               # Named SQL queries, no ORM — admin, analytics, cart, collections,
│                              # customers, downloads, email, import, orders, pages, products,
│                              # shipping, system-log, tax, themes
├── routes/
│   ├── storefront/            index.ts, checkout.ts, account.ts, downloads.ts
│   ├── admin/                  auth, products, collections, pages, orders, navigation, themes,
│   │                            emails, import, settings, shipping, tax, users, index
│   └── (no api/ directory — despite what an earlier README draft said)
├── theme/
│   ├── engine.ts              # Handlebars compile/render/cache per theme, asset routes
│   ├── assets.ts              # Content-hash asset manifest
│   ├── helpers.ts             # Built-in Handlebars helpers, see Section 8
│   ├── context.ts             # GlobalContext + page context builders
│   ├── config.ts               # theme.json manifest loader, config resolver
│   └── registry.ts             # Active-theme registry, live-preview state
├── commerce/                 # products.ts, collections.ts, cart.ts — business logic over db/queries
├── admin/                    # auth.ts, images.ts, render.ts, store-media.ts, themes.ts (server-side
│                              # helpers for the admin panel, distinct from the top-level admin/ views)
├── email/                    # transport.ts, send.ts, templates.ts, sample-data.ts,
│                              # transports/{console,resend,smtp}.ts
└── import/woocommerce/       # wxr.ts, rest-client.ts, mapper.ts, jobs.ts, image-fetch.ts

admin/                       # Admin Handlebars templates (not TypeScript)
├── partials/layout.hbs        # Admin shell: sidebar, htmx/Alpine/Tailwind CDN script tags
├── dashboard.hbs, login.hbs, setup.hbs, settings.hbs, navigation.hbs, import.hbs, 404.hbs
└── collections/, emails/, orders/, pages/, products/, shipping/, tax/, themes/, users/

themes/linen/                # Bundled default theme (see Section 4)

data/, uploads/              # Runtime state — SQLite file, product images, digital product files.
                             # Not baked into the Docker image; mount volumes for persistence.
```

## 4. Theme File Structure

Themes are plain directories. No build step — Handlebars, CSS, and JS are served as-is with content-hash filenames. There is no esbuild/Tailwind CLI processing step for uploaded themes, despite that being planned originally.

```
linen/
├── theme.json              # Manifest + config schema (Section 6)
├── index.hbs                # Homepage
├── product.hbs               # Product page
├── collection.hbs            # Collection / category listing
├── cart.hbs                  # Cart page
├── checkout.hbs               # Checkout (+ checkout-success.hbs, checkout-cancel.hbs)
├── page.hbs                  # Generic content page (renders page-builder sections)
├── search.hbs                # Search results (LIKE-based, see Section 15)
├── account*.hbs               # Customer account pages (login, register, orders, order detail)
├── 404.hbs
├── THEME.md                  # Human-facing notes for whoever edits this theme
├── partials/
│   ├── header.hbs, footer.hbs, cart-contents.hbs, pagination.hbs, product-card.hbs
│   └── sections/              # Page-builder section partials, one per section type (see §6.5)
├── assets/
│   ├── style.css              # Plain CSS with custom properties — no Tailwind, no build step
│   ├── main.js
│   └── images/
└── locales/
    └── en.json                # Present but not currently wired to the {{t}} helper (see Section 8)
```

## 5. `theme.json` Config Schema

Config options are flat groups of typed fields, resolved as `section.key` (e.g. `layout.showHero`), with a merchant override stored per-theme in `themes.config_overrides` (JSON). Supported field types: `color`, `text`, `select` (with `options`), `boolean`, `image`, and `repeater` (rows of sub-fields, each with its own type — including a `collection` sub-type that renders as a `<select>` of the store's collections). There is no `range`, `richtext`, or `video` field type.

The bundled `linen` theme's actual config:

```json
{
  "name": "linen",
  "version": "1.0.0",
  "engine": ">=1.0.0",
  "description": "Clean, minimal ecommerce theme",
  "author": "Core Team",
  "config": {
    "colors": {
      "primary": { "type": "color", "default": "#1A1A2E", "label": "Primary (text / buttons)" },
      "accent": { "type": "color", "default": "#E94560", "label": "Accent (links / badges)" },
      "background": { "type": "color", "default": "#FFFFFF", "label": "Page background" },
      "headerBackground": { "type": "color", "default": "#FFFFFF", "label": "Header background" },
      "headerText": { "type": "color", "default": "#111827", "label": "Header link colour" },
      "heroBackground": { "type": "color", "default": "#1A1A2E", "label": "Hero background" }
    },
    "typography": {
      "headingFont": { "type": "select", "default": "Inter", "options": ["Inter", "Playfair Display", "Space Grotesk"], "label": "Heading font" }
    },
    "layout": {
      "productsPerRow": { "type": "select", "default": "3", "options": ["2", "3", "4"], "label": "Products per row" },
      "showHero": { "type": "boolean", "default": true, "label": "Show homepage hero" },
      "heroEyebrow": { "type": "text", "default": "New Collection", "label": "Hero eyebrow text" },
      "heroHeading": { "type": "text", "default": "Welcome to our store", "label": "Hero heading" },
      "heroSubheading": { "type": "text", "default": "Curated goods for considered living.", "label": "Hero subheading" },
      "heroImage": { "type": "image", "default": "", "label": "Hero image" },
      "heroImageFit": { "type": "select", "default": "cover", "options": ["cover", "contain"], "label": "Image fit" },
      "heroImagePadding": { "type": "select", "default": "0px", "options": ["0px", "0.75rem", "1.5rem", "3rem"], "label": "Image padding" },
      "heroPosition": { "type": "select", "default": "background", "options": ["background", "center", "left", "right"], "label": "Image position" },
      "heroAlign": { "type": "select", "default": "left", "options": ["left", "center"], "label": "Text alignment" },
      "featuredSections": {
        "type": "repeater",
        "default": [{ "title": "Featured Products", "collection": "", "count": "8", "sort": "featured" }],
        "label": "Featured sections",
        "itemFields": {
          "title": { "type": "text", "default": "Featured Products", "label": "Section title" },
          "collection": { "type": "collection", "default": "", "label": "Collection (blank = all products)" },
          "sort": { "type": "select", "default": "featured", "options": ["featured", "newest"], "label": "Sort" },
          "count": { "type": "select", "default": "8", "options": ["4", "6", "8", "12", "16"], "label": "Number of products" }
        }
      }
    }
  }
}
```

## 6. Template Data Contract

Every template receives a context object. These are the real interfaces from `src/theme/context.ts` — not a proposed contract, the actual TypeScript shipped.

### 6.1 Global Context

```ts
interface GlobalContext {
  store: {
    name: string;
    tagline: string;
    url: string;
    logo: string | null;
    icon: string | null;
    currency: { code: string; symbol: string; position: 'before' | 'after' };
    cartLabel: string;
    cartSlug: string;                 // cart URL is configurable, not hardcoded to /cart
    customerAccountsEnabled: boolean;
  };
  theme: { config: Record<string, Record<string, unknown>> };
  cart: { itemCount: number; subtotal: Money };
  customer: { loggedIn: boolean; firstName: string | null } | null;
  navigation: { main: NavItem[]; footer: NavItem[] };
  currentPath: string;
  pageTitle?: string;
  metaDescription?: string;
  ogImage?: string | null;
  tax: { enabled: boolean; displayMode: 'inc' | 'ex' | 'both'; label: string };
}

interface Money {
  amount: number;      // Minor units (pence/cents)
  formatted: string;   // Pre-formatted: '£29.99'
  currency: string;
}

interface NavItem { label: string; url: string; active: boolean; children: NavItem[] }
```

### 6.2 Product Context

```ts
interface ProductPageContext extends GlobalContext {
  product: {
    id: string; title: string; slug: string;
    description: string;               // HTML
    price: Money; compareAtPrice: Money | null; onSale: boolean;
    images: Image[]; variants: Variant[];
    options: { name: string; values: string[] }[];
    available: boolean; vendor: string | null; tags: string[];
    relatedProducts: ProductSummary[];
  };
}

interface Image { original: string; thumbnail: string; medium: string; large: string; alt: string }

interface ProductSummary {
  id: string; title: string; slug: string;
  price: Money; compareAtPrice: Money | null; onSale: boolean;
  image: Image | null; available: boolean; vendor: string | null;
  taxRate: string | null;
}

interface Variant {
  id: string; title: string;
  price: Money; compareAtPrice: Money | null; sku: string | null;
  available: boolean; options: Record<string, string>; image: Image | null;
}
```

### 6.3 Collection Context

```ts
interface CollectionPageContext extends GlobalContext {
  collection: {
    id: string; title: string; slug: string; description: string | null; image: Image | null;
    products: ProductSummary[];
    pagination: { currentPage: number; totalPages: number; hasNext: boolean; hasPrev: boolean;
                  nextUrl: string | null; prevUrl: string | null };
    sort: { current: string; options: { value: string; label: string }[] };
  };
}
```

### 6.4 Cart Context

```ts
interface CartPageContext extends GlobalContext {
  cart: {
    items: CartItem[]; itemCount: number; subtotal: Money;
    discountCode: string | null; discountAmount: Money | null; total: Money;
    empty: boolean; checkoutUrl: string;
  };
}

interface CartItem {
  id: string; productTitle: string; variantTitle: string; quantity: number;
  price: Money; lineTotal: Money; image: Image; productSlug: string; variantId: string;
  freeShipping: boolean; isDigital: boolean; taxRate: string | null;
}
```

Checkout, account, and page-builder templates follow the same `GlobalContext`-extension pattern above but don't have a single named interface each yet — they're assembled ad hoc in `src/routes/storefront/checkout.ts` and `account.ts`.

### 6.5 Page-builder sections (the section contract)

The visual page builder is split so the **engine is theme-agnostic** and the
**look is per-theme**. The core (`src/theme/sections.ts`) owns the *catalogue* of
section types and their settings; each theme owns *how each section looks*. A
theme opts into the builder by satisfying two things — section partials and
render hooks — and everything else (the editor, storage, drafts, reusable
blocks, templates, live preview) works unchanged.

**1. Section partials.** For every section type it wants to support, a theme
ships `partials/sections/<type>.hbs`. The partial is rendered with the section's
**settings as its root context** — so a `hero` partial reads `{{heading}}`,
`{{src}}`, etc., and a repeater section iterates its items (`{{#each images}}`).
A theme only needs partials for the types it supports: **a missing partial makes
that section render nothing** (`renderSection` returns `''` — no error), so
partial themes degrade gracefully.

Current section types (17): `reusable`, `hero`, `featured_products`, `gallery`,
`testimonials`, `logo_row`, `slideshow`, `faq`, `newsletter`, `video`, `map`,
`spacer`, `text`, `image`, `image_text`, `cta`, `columns`. The authoritative
list and each type's fields live in `src/theme/sections.ts` (`listSectionSchemas()`).

**2. Render hooks.** A theme decides *where* sections appear by looping them
through the `renderSection` helper (§7):

| Template | Hook | What it renders |
|---|---|---|
| `page.hbs` | `{{#each page.sections}}{{renderSection this}}{{/each}}` | CMS pages **and** the home page (the home is a page flagged as home) |
| `product.hbs` | `{{#each contentSections}}{{renderSection this}}{{/each}}` | Product-page template + that product's own sections, below the product |
| `collection.hbs` | `{{#each contentSections}}{{renderSection this}}{{/each}}` | Collection-page template + that collection's own sections |
| `index.hbs` | *(theme's own markup)* | The default themed home — only the fallback when no page is set as home |

**3. Server-resolved sections.** Some sections are resolved before the theme
sees them, so the partial just renders plain data:
- `featured_products` arrives with a resolved `products` array (+ `collectionSlug`, `columns`).
- `reusable` is **expanded** server-side into the referenced block's sections — the theme never renders a `reusable` partial.
- `video` / `map` partials call the `video_embed` / `map_embed` helpers to turn a URL/address into an embed.

**4. Conventions the bundled themes follow (optional but recommended):**
- **Colour controls** set inline custom properties (`--section-bg`, `--section-text`; hero uses `--hero-bg`/`--hero-text`); the theme's CSS reads them with a fallback, e.g. `background-color: var(--section-bg, transparent)`. Site-colour swatches are theme tokens (`var(--color-accent)` etc.), pulled from the *active* theme's config — not hardcoded.
- **Slideshow** needs a small carousel initialiser in the theme's `main.js` (targets `[data-slideshow]`).

**Fastest path for a new/custom theme:** copy `partials/sections/`, the section
CSS, the four render hooks, and the slideshow JS from a bundled theme, then
restyle. Sections the theme omits simply won't appear.

## 7. Built-in Handlebars Helpers

The real, complete list from `src/theme/helpers.ts`:

| Helper | Purpose |
| --- | --- |
| `money` | Formats a `Money` object using the store's currency symbol |
| `pence` | Formats a raw integer-pence amount, same output shape as `money` |
| `asset` | Resolves a theme asset filename to its content-hashed URL |
| `url` | Resolves a route URL: `(url 'product' slug)`, `(url 'collection' slug)`, `(url 'cart')`, `(url 'search')`, `(url 'page' slug)` |
| `csrf_field` | Emits `<input type="hidden" name="_csrf" value="...">` |
| `stock_badge` | `'In Stock'` / `'Sold Out'` from `variant.available` |
| `ex_tax_price` | Formats a price excluding tax, given an inclusive amount and a resolved tax band |
| `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `or`, `and` | Comparison/logic subexpressions |
| `is` | Equality check — works as both a block (`{{#is a b}}`) and a subexpression |
| `if_eq` | Block-only equality helper |
| `pluralize` | Singular/plural string from a count |
| `truncate` | Truncates text, appends `…` |
| `t` | i18n stub — currently returns the key unchanged. `themes/linen/locales/en.json` exists but isn't wired up yet |
| `json` | Pretty-prints a value in a `<pre>` block, for debugging |
| `parseJson` | Parses a JSON string, returns `{}` on failure |
| `timestamp` | Formats a date as `en-GB`, `DD Mon YYYY` |
| `meta_title` | Emits `<title>` from `pageTitle`/`store.name` |
| `meta_description` | Emits `<meta name="description">` |
| `canonical_url` | Emits `<link rel="canonical">` |
| `og_tags` | Emits OpenGraph meta tags |
| `structured_data` | Stub — returns an empty string. No JSON-LD is emitted currently |
| `renderSection` | Renders one page-builder section by dispatching to the matching `partials/sections/{type}` partial. Exposes the page root as `@root` inside the partial (e.g. `{{@root.csrfToken}}` for the newsletter form). See §6.5 |
| `video_embed` | YouTube/Vimeo watch URL → embeddable player URL (`''` if unrecognised) — used by the `video` section |
| `map_embed` | Address → keyless Google Maps embed URL — used by the `map` section |
| `pagination` | Renders prev/next links from a pagination object |

## 8. htmx Interaction Patterns

The server returns full pages for normal requests and HTML fragments for htmx requests. No client-side state, no JSON parsing on the frontend.

### 8.1 Storefront: Add to Cart

Real markup from `themes/linen/product.hbs` — note the cart URL is driven by `store.cartSlug`, not hardcoded:

```html
<form hx-post="/{{store.cartSlug}}/add"
      hx-target="#cart-count"
      hx-swap="outerHTML"
      hx-indicator="#add-spinner">
  {{csrf_field}}
  <input type="hidden" name="variantId" value="{{product.variants.0.id}}">
  <input type="number" name="quantity" value="1" min="1" class="qty-input">
  <button type="submit" {{#unless product.available}}disabled{{/unless}}>Add to Cart</button>
  <span id="add-spinner" class="htmx-indicator">Adding…</span>
</form>
```

### 8.2 Storefront: Cart Line Updates

Real markup from `themes/linen/partials/cart-contents.hbs`:

```html
<input type="number" value="{{this.quantity}}" name="quantity"
       hx-post="/{{../store.cartSlug}}/update"
       hx-target="#cart-contents" hx-swap="outerHTML"
       hx-vals='{"itemId": "{{this.id}}"}'
       hx-trigger="change">
<button hx-delete="/{{../store.cartSlug}}/remove/{{this.id}}"
        hx-target="#cart-contents" hx-swap="outerHTML">×</button>
```

### 8.3 Admin: Theme Config Live Preview

The theme customiser (`admin/themes/config.hbs`) doesn't submit on every keystroke via htmx — it debounces (400ms) and POSTs the whole config form to `/admin/themes/:id/preview-apply`, which updates the in-memory active-theme config (not persisted) and reloads a preview `<iframe>`. Colour/font fields also patch CSS custom properties directly via JS for instant feedback before the debounced round-trip lands. Saving for real is a separate POST to `/admin/themes/:id/config`. Repeater fields (like `featuredSections`) add/remove rows client-side with plain DOM manipulation, then submit as bracket-indexed fields (`layout.featuredSections[0][title]`) that the server reassembles into an array.

### 8.4 Server-Side Pattern

```ts
fastify.post(`/${cartSlug}/add`, async (req, reply) => {
  // ...adds to cart...
  if (req.headers['hx-request']) {
    return reply.type('text/html').send(renderCartCountFragment(cart));
  }
  return reply.redirect(`/${cartSlug}`);
});
```

## 9. Rendering Pipeline

### 9.1 Request Lifecycle

1. Fastify receives the request. Session, CSRF, and the analytics `onSend` hook are registered as plugins/hooks.
2. Router matches URL to a storefront/admin/webhook handler.
3. Handler queries SQLite directly via `src/db/queries/*` (no ORM, no query batching layer).
4. Context builder (`buildGlobalContext` + page-specific additions) merges global context, page data, and resolved theme config.
5. `ThemeEngine.render()` compiles the template (LRU-cached, 100 entries) and renders to an HTML string.
6. Response is sent as a full page or an htmx fragment.

There is no formal per-request latency target or timeout enforced in code — the "under 100ms / under 300ms" and "5-second render timeout" figures from the original planning spec were never implemented as actual guarantees.

### 9.2 Template Engine (`src/theme/engine.ts`, real implementation)

```ts
export class ThemeEngine {
  private cache = new LRUCache<string, HandlebarsTemplateDelegate>({ max: 100 });
  private hbs: typeof Handlebars;
  private assetManifest: AssetManifest = {};

  constructor(public readonly themePath: string) {
    this.hbs = Handlebars.create();
  }

  async init(): Promise<void> {
    this.assetManifest = await buildAssetManifest(this.themePath);
    await this.registerPartials();
    registerHelpers(this.hbs, (f) => this.resolveAsset(f), (t, s) => this.resolveUrl(t, s));
  }

  async render(templateName: string, context: unknown): Promise<string> {
    let compiled = this.cache.get(templateName);
    if (!compiled) {
      const src = await readFile(path.join(this.themePath, `${templateName}.hbs`), 'utf-8');
      compiled = this.hbs.compile(src, { preventIndent: true });
      this.cache.set(templateName, compiled);
    }
    return compiled(context);
  }

  invalidateAll(): void { this.cache.clear(); }
}
```

There's no dedicated dev-mode file watcher or WebSocket live-reload — `npm run dev` uses `tsx watch`, which restarts the whole Node process on `src/**` changes. Editing a theme `.hbs`/`theme.json` file directly doesn't trigger that restart; the compiled-template cache is only cleared when the admin theme customiser explicitly reloads (activating a theme, or saving/previewing its config). Restart `npm run dev` to pick up raw theme-file edits made outside the customiser.

### 9.3 Caching

- Template compilation: in-memory LRU cache (100 entries), invalidated on theme activation or config save/preview — not on file-change detection.
- No query-result cache layer exists (the original spec's "60-second TTL Map cache" was never built).
- No full-page caching.
- Asset files: served with `Cache-Control: public, max-age=31536000, immutable` because filenames are content-hashed.

## 10. Image Handling

Real sizes from `src/admin/images.ts`, `processUploadedImage()`:

```ts
const SIZES = {
  thumbnail: { width: 100, height: 100 },   // fit: 'cover'
  medium:    { width: 600, height: 600 },   // fit: 'inside', withoutEnlargement
  large:     { width: 1200, height: 1200 }, // fit: 'inside', withoutEnlargement
};
```

All four variants (original + 3 sizes) are re-encoded to WebP and written to `uploads/products/{uuid}/`. Template usage is unchanged from the original design:

```html
<img src="{{product.images.0.medium}}"
     srcset="{{product.images.0.thumbnail}} 200w, {{product.images.0.medium}} 600w, {{product.images.0.large}} 1200w"
     sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
     alt="{{product.images.0.alt}}" loading="lazy">
```

**Digital products** are a separate, unrelated upload path: `uploadDigitalFile` in `src/routes/admin/products.ts` stores the raw file (no sharp processing, original extension preserved) under `uploads/digital/{uuid}{ext}`, tracked in `product_files`, and delivered post-purchase via signed, expiring tokens (`order_downloads`, served from `src/routes/storefront/downloads.ts`).

## 11. Payments

Two providers, either or both active at once, configured from **Settings → Payments** (stored in `store_settings`, env vars as fallback defaults):

- **Stripe** — real SDK (`stripe` npm package). Uses Checkout Sessions (`stripe.checkout.sessions.create`, mode `payment`), a `GET /checkout/stripe/return` handler, and a signed webhook at `POST /webhooks/stripe` (verified via `stripe.webhooks.constructEvent`). Order fulfilment is idempotent — checked via `findOrderByPaymentReference` before marking an order paid from either the return handler or the webhook, since both can fire for the same order.
- **PayPal** — no SDK. Raw REST calls via `fetch` to `api-m.paypal.com` (or `api-m.sandbox.paypal.com` depending on the configured mode), OAuth2 client-credentials token exchange, then `POST /v2/checkout/orders` to create and `POST /v2/checkout/orders/:id/capture` to capture, called from `/checkout/paypal/create` and `/checkout/paypal/capture`. The PayPal JS SDK button drives the flow client-side.

Shipping and tax are resolved server-side per order (`getRatesForCountry`, per-item tax-band lookups), with pseudo shipping rates for all-digital carts (no shipping needed) and products flagged free-shipping.

## 12. Admin Panel Architecture

Server-rendered Handlebars with htmx, same Fastify server and template engine as the storefront. No separate build step, no API layer between admin templates and the database.

### 12.1 Roles

`admin_users.role` is a plain string, `'admin'` or `'staff'`. Staff accounts are blocked (via a path-prefix guard in `src/routes/admin/index.ts`) from `/admin/settings`, `/admin/import`, `/admin/themes`, `/admin/emails`, `/admin/navigation`, and `/admin/users` — they can manage products and orders only.

### 12.2 Admin Routes

All mounted under `/admin`, one file per area in `src/routes/admin/`:

| Area | Routes |
| --- | --- |
| `auth.ts` | `GET/POST /login`, `POST /logout`, `GET/POST /setup` |
| `products.ts` | list/new/edit/delete, image upload/delete, digital file upload/delete |
| `collections.ts` | list/new/edit/delete, add/remove product |
| `pages.ts` | list/new/edit/delete, section-builder image upload |
| `orders.ts` | list, detail (read-only — no status-update route yet) |
| `navigation.ts` | `GET/POST /navigation` (main + footer nav editor) |
| `themes.ts` | list, activate, config editor, live-preview apply, config image upload/remove, zip upload |
| `emails.ts` | list, edit, preview, send test |
| `import.ts` | WXR upload, WooCommerce REST connect, job status polling |
| `settings.ts` | store settings, email config + test, media, **payments**, restart, tax |
| `shipping.ts` | zones and rates CRUD |
| `tax.ts` | bands and rates CRUD |
| `users.ts` | list, invite, change role, delete |
| `index.ts` | dashboard (order/product counts + analytics summary), route registration, role guard |

## 13. Database Schema

SQLite throughout — `TEXT` UUID primary keys, `INTEGER` booleans, `datetime('now')` defaults, JSON stored as `TEXT`. 21 migrations, applied automatically on every server boot (no separate migrate step required, though `npm run db:migrate` exists for manual runs):

| # | File | Adds |
| --- | --- | --- |
| 001 | `001_initial.sql` | `products`, `product_images`, `product_variants`, `collections`, `collection_products`, `carts`, `cart_items` |
| 002 | `002_admin_orders.sql` | `admin_users`, `orders`, `order_items`, `store_settings` |
| 003 | `003_themes.sql` | `themes`, seeds the built-in `linen` theme as active |
| 004 | `004_store_media.sql` | Logo/icon settings |
| 005 | `005_email.sql` | Email provider settings, `email_templates` (4 seeded), `email_log` |
| 006 | `006_woocommerce_import.sql` | `wc_id` columns for import matching, `import_jobs` |
| 007 | `007_pages.sql` | `pages` |
| 008 | `008_page_sections.sql` | `pages.sections` (JSON — the page builder) |
| 009 | `009_checkout.sql` | `orders.payment_provider`, `orders.payment_reference` |
| 010 | `010_system_log.sql` | `system_log` |
| 011 | `011_store_tagline.sql` | `store_tagline` setting |
| 012 | `012_analytics.sql` | `page_views` |
| 013 | `013_users.sql` | `admin_users.role`, `customers` |
| 014 | `014_customer_accounts.sql` | `customer_accounts_enabled` setting |
| 015 | `015_seo.sql` | `seo_title`/`seo_description` on products, collections, pages |
| 016 | `016_shipping.sql` | `shipping_zones`, `shipping_rates`, order shipping fields |
| 017 | `017_product_free_shipping.sql` | `products.free_shipping` |
| 018 | `018_tax.sql` | `orders.tax_amount` |
| 019 | `019_product_tax_rate.sql` | `products.tax_rate` |
| 020 | `020_tax_bands.sql` | `tax_bands`, `tax_rates`, `products.tax_band_id` |
| 021 | `021_digital_products.sql` | `products.is_digital`, `product_files`, `order_downloads` |

Representative real tables:

```sql
CREATE TABLE products (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  description TEXT, description_plain TEXT, vendor TEXT, tags_text TEXT DEFAULT '',
  published INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT
  -- + wc_id, seo_title, seo_description, free_shipping, tax_rate, tax_band_id, is_digital
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY, order_number INTEGER NOT NULL UNIQUE, email TEXT NOT NULL,
  status TEXT DEFAULT 'pending', fulfillment TEXT DEFAULT 'unfulfilled',
  subtotal INTEGER DEFAULT 0, discount_amount INTEGER DEFAULT 0, shipping INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0, currency TEXT DEFAULT 'GBP', discount_code TEXT, notes TEXT,
  shipping_address TEXT DEFAULT '{}', billing_address TEXT DEFAULT '{}',
  created_at TEXT, updated_at TEXT
  -- + wc_id, payment_provider, payment_reference, shipping_rate_id, shipping_title, tax_amount
);

CREATE TABLE admin_users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', created_at TEXT, updated_at TEXT
  -- + role TEXT NOT NULL DEFAULT 'admin'
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published', wc_id INTEGER, created_at TEXT, updated_at TEXT
  -- + sections TEXT NOT NULL DEFAULT '[]', seo_title, seo_description
);

CREATE TABLE themes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL DEFAULT '1.0.0', description TEXT DEFAULT '', author TEXT DEFAULT '',
  directory TEXT NOT NULL, manifest TEXT NOT NULL DEFAULT '{}',
  config_overrides TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT, updated_at TEXT
);
CREATE UNIQUE INDEX idx_themes_active ON themes (active) WHERE active = 1;
```

## 14. Search

Plain SQL, not full-text search — despite that being a v1 goal. `src/db/queries/products.ts`:

```ts
export function searchProducts(q: string, limit = 40): ProductRow[] {
  const like = `%${q}%`;
  return query<ProductRow>(
    `${PRODUCT_SUMMARY_SQL} WHERE p.published = 1
     AND (p.title LIKE ? OR p.description LIKE ? OR p.vendor LIKE ? OR p.tags_text LIKE ?)
     ORDER BY p.created_at DESC LIMIT ?`,
    [like, like, like, like, limit],
  );
}
```

No relevance ranking, no typo tolerance, no FTS5 virtual table, and no cross-content search — `GET /search` only searches products, not pages or collections. This comfortably handles small-to-medium catalogues but doesn't rank matches.

## 15. Asset Pipeline

Theme assets are content-hashed at theme load time — no build step for plain CSS/JS themes (which is all that's supported today; there's no esbuild/Tailwind CLI pass for uploaded themes).

```ts
// src/theme/assets.ts
export function contentHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}
// 'style.css' -> 'style.a1b2c3d4.css', served from /theme/assets/*
// with Cache-Control: public, max-age=31536000, immutable
```

## 16. Security

- Handlebars auto-escapes all output by default. `{{{raw}}}` triple-stache is used only for pre-sanitised HTML (page/product content, section-builder text).
- CSRF: `@fastify/csrf-protection`, tokens via `reply.generateCsrf()` and the `{{csrf_field}}` helper, on all state-changing forms.
- Admin routes behind session-based auth (`@fastify/session`); staff role restricted to a subset of routes (Section 12.1).
- Theme zip uploads (`installThemeFromZip` in `src/admin/themes.ts`) reject path traversal (entries starting with `..` or absolute paths), require a single top-level directory containing `theme.json`, and derive the theme slug by sanitising the manifest name. There's no zip-bomb / decompression-ratio guard.
- Passwords hashed with argon2id — used identically for admin accounts and customer accounts.
- Sessions: `httpOnly`, `sameSite: 'lax'`, `secure` in production, 8-hour expiry. In-memory session store (not persisted across restarts).
- Analytics bot filtering uses a user-agent regex; IPs are SHA-256 hashed (truncated to 16 hex chars) before storage, never stored raw.
- **Gaps, stated plainly**: no Content-Security-Policy header anywhere (`@fastify/helmet` isn't installed), no rate limiting on login or checkout endpoints, no automated tests to catch regressions in any of the above.

## 17. Not Implemented

Things the original spec (or the product's marketing site) describes that don't exist in the code today — listed so nobody assumes otherwise:

- **GraphQL API**, **CLI** (`taberno ...` commands), **hot-reload dev tooling** (file watcher + WebSocket) — none exist. `npm run dev` is `tsx watch`, full-process restart only.
- **Full-text search** (FTS5/tsvector, ranking, typo tolerance) — actual search is `LIKE`, see Section 14.
- **i18n** — the `{{t}}` helper is a stub; `locales/en.json` isn't consulted at render time.
- **JSON-LD structured data** — `{{structured_data}}` returns an empty string.
- **Background job queue** — no Redis, no pg-boss/better-queue; WooCommerce imports run inline with a polled progress row.
- **Automated tests** — no unit, integration, or E2E tests exist; no test runner is configured.
- **Rate limiting / CSP headers** — see Section 16.
- **Order status updates from the admin UI** — orders are viewable but there's no route to change status yet.

## 18. Where to Look

- [README.md](README.md) — operator-facing setup, requirements, feature walkthrough, Docker.
- `src/db/migrations/` — the actual schema, in order; read these before trusting any ERD.
- `src/theme/` — the whole rendering pipeline lives in five files (`engine.ts`, `assets.ts`, `helpers.ts`, `context.ts`, `config.ts`, `registry.ts`).
- `themes/linen/` — the only theme shipped; also the best worked example of the template contract in Section 6.
