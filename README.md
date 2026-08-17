# Taberno

Self-hosted ecommerce platform. Keeping it simple with Node.js + SQLite.

## Features

**Selling**
- Products with variants, images, digital downloads, SEO fields, inventory tracking, and optional **availability windows** (a "product calendar" — visible always, purchasable only between set dates, with optional **pre-orders** during the run-up)
- Collections, search, and genuinely-related "You may also like" (shared-collection, with an optional manual per-product picker) plus cart recommendations
- Cart + checkout with **Stripe** (hosted Checkout → Apple/Google Pay) and **PayPal**; guest checkout
- Shipping zones & rates (flat, free, free-over-threshold, **local collection/pickup** with per-location address & hours, or **bookable date/time slots**); tax bands (inc/ex display)
- **Promotions**: discount codes, **automatic discounts** (order % / fixed off over a threshold, and buy-X-get-Y / BOGO), and scheduled **promo banners**
- **Product reviews** with star ratings, verified-purchase badges, moderation, and rich-result structured data
- **B2B / wholesale**: customer groups (e.g. Trade) with **group pricing** (a store-wide % off plus inc/ex-tax display) and **pay-on-account checkout** — approved groups place orders as unpaid invoices on net terms; an invoice email is sent and the merchant marks the order paid once settled (order data is structured for a future accounting sync, e.g. Xero)

**Marketing & growth**
- **Blog** on the page-builder engine (featured image, author, scheduling, RSS, sitemap)
- **Abandoned-checkout recovery** emails with one-click unsubscribe
- **Low-stock alerts** to the store owner
- Meta/Google **pixels + product feed**, newsletter capture + broadcasts
- SEO: sitemap.xml, robots.txt, meta/OG tags, canonical URLs, structured data

**Operations**
- Orders: fulfilment + tracking, refunds (Stripe/PayPal), merchant notifications, CSV export
- Customer accounts: registration, password reset, email verification
- **Sales/analytics dashboard**: revenue, orders, AOV, conversion (period-over-period), best-sellers, traffic
- Editable transactional email templates with live preview
- Staff accounts with restricted access; admin **two-factor auth**
- One-click **self-update** + revert; online **backup/restore**; `/health` endpoint
- WooCommerce import; full store export/import

**Storefront**
- Two bundled, fully-configurable themes — **Linen** (clean/editorial) and **Nova** (bold/modern, with a repeater-driven hero slider) — plus uploadable custom themes. The page builder is theme-agnostic: any theme supports it by shipping a partial per section type and the `renderSection` hooks (the "section contract" — see [`theme_engine_spec.md`](theme_engine_spec.md) §6.5 and each theme's `THEME.md`); sections a theme doesn't implement simply don't render
- Configurable cart word (Cart / Basket / Bag); a **visual page builder** with **live preview** — every page is built from drag-to-reorder, schema-declared sections (hero, featured products, gallery, testimonials, logo row, slideshow, FAQ, newsletter, video, map/contact, spacer, text, image, image + text, call-to-action, columns — with colour controls) in a two-pane editor with live preview (draft/publish, drag-reorder, reusable blocks); any page can be set as the storefront home page, and product & collection pages take shared templates plus per-item sections; editable navigation with optional mega menus (columns of links, categories with pictures, or products)

## Requirements

- Node.js 22+ (`better-sqlite3` requires it as of v13). 22 (LTS) is the tested baseline — CI, Docker, and `.nvmrc` all pin it — but `better-sqlite3`, `argon2`, and `sharp` all ship N-API prebuilt binaries now, so newer versions (e.g. 26) work fine too.
- npm

If you're ever on a platform/Node combination with no prebuilt binary available, these fall back to a from-source compile, which needs a C++ toolchain (`build-essential` on Debian/Ubuntu, `apk add python3 make g++` on Alpine). The `Dockerfile` sidesteps this by installing the toolchain in the build stage regardless.

## Quick start

```bash
git clone <this repo>
cd taberno
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:3000/admin](http://localhost:3000/admin). With no admin account yet you'll land on a setup page to create your credentials.

The database schema is created automatically on first boot, there is no separate migration step.

## After logging in

1. **Settings > Store** - store name, currency, contact email, tagline. Toggle customer accounts on/off here.
2. **Settings > Email** - how transactional emails get sent. Defaults to logging to the server console (fine for local dev). For real sending, pick Resend (API key only) or a custom SMTP provider. Use the test button to confirm it works.
3. **Settings > Payments** - paste in Stripe and/or PayPal credentials. Both providers can be active at the same time.
4. **Settings > Logs** - live view of payment events, sent emails, and server errors. Useful for debugging without touching the server.
5. **Emails** - editable Handlebars templates for order confirmation, shipping, admin notifications, password reset. Live preview against sample data.
6. **Themes** - two bundled themes ship in-repo: **Linen** (clean/editorial, active by default) and **Nova** (bold/modern with a repeater-driven hero slider). Switch between them, customise colours/fonts/layout from the config page, or upload a custom theme.
7. **Pages** - build pages with a section builder (text, image, image + text, CTA, columns), or import from a WordPress export via **Import**.
8. **Blog** - write posts with the same section builder, plus featured image, author, and scheduled publish dates. Each post has an RSS feed and appears in the sitemap.
9. **Promotions** - discount codes, automatic (codeless) discounts and buy-X-get-Y offers, and scheduled announcement banners.
10. **Reviews** - customer product reviews with star ratings, verified-purchase badges, and approve/publish moderation.
11. **Analytics** - sales dashboard (revenue, orders, AOV, conversion with period-over-period deltas, best-sellers) on top of the traffic view (page views, unique visitors, top pages, referrers).
12. **Marketing** - Meta/Google pixels and a product feed, newsletter capture, and one-off broadcasts on your email setup.
13. **Navigation** - edit the main and footer nav links (add a `/blog` link here to surface the blog). Any header link can be given a **mega menu** built from columns, where each column is one of: plain **links**, **categories** (pick a collection from a dropdown, with an optional picture), or **products** (pick a collection and how many to show — as thumbnails, a list with images, or a text-only list, with an optional "Show more" link). Choose how many columns show per row (or leave it automatic). The panel is centred at the content width and renders in both bundled themes (hover on desktop, expand inline on mobile).
14. **Users** - add staff accounts with restricted access; enable two-factor auth on any account under **Account**.
15. **Products / Collections** - `npm run db:seed` loads sample catalogue data, or add your own.

Traffic analytics are collected from storefront requests with no external service or cookie consent needed — bots are filtered by user agent and IPs are hashed before storage.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start with hot reload |
| `npm start` | Start the built server (`npm run build` first) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run db:migrate` | Apply pending migrations manually |
| `npm run db:seed` | Seed with sample products/collections |
| `npm run db:backup` | Snapshot the database (safe while running) |
| `npm run db:restore <file>` | Restore the database from a snapshot |

## Backups

The entire store — products, orders, customers, settings — lives in a single
SQLite file (`DATABASE_PATH`, default `data/store.db`). Back it up regularly.

```bash
# Snapshot now → backups/store-<timestamp>.db (uses SQLite's online backup,
# so it's safe to run against a live server — no downtime needed).
npm run db:backup

# …or to a specific path (e.g. a mounted volume):
npm run db:backup /mnt/backups/store.db
```

Schedule it with cron, e.g. hourly with 7-day retention:

```cron
0 * * * * cd /app && npm run db:backup >> /var/log/taberno-backup.log 2>&1
0 3 * * * find /app/backups -name 'store-*.db' -mtime +7 -delete
```

To restore (**stop the server first** — this overwrites the live file; the
current database is copied to `<db>.pre-restore` as a safety net):

```bash
npm run db:restore backups/store-20260727-104512.db
```

## Configuration

Copy `.env.example` to `.env`:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `NODE_ENV` | `development` | Set to `production` when deploying |
| `THEME_DIR` | `themes/linen` | Active theme directory |
| `UPLOADS_DIR` | `uploads` | Product image uploads |
| `SESSION_SECRET` | (dev default) | Use a strong random value in production |
| `DATABASE_PATH` | `data/store.db` | SQLite file location |

Store-level settings (name, currency, logo, email provider, etc.) are in the admin UI, not env vars.

## Health check

`GET /health` returns `200 {"status":"ok"}` when the process is up and the
database is reachable, or `503` otherwise. Point Docker healthchecks, load
balancers, or uptime monitors at it — it's excluded from session/cart handling
and analytics, so probing it has no side effects.

## Updating

For a **git-checkout deploy run under a supervisor**, the admin shows an
"update available" banner when the checkout is behind `origin/master`, and
Settings → Server has a one-click **Update now** button. It pulls, `npm install`,
`npm run build` — all while the old code keeps serving — then exits so the
supervisor restarts into the new code. If any step fails it resets the checkout
to the previous commit and does **not** restart, so a bad commit can't take the
store down. A **Revert** button appears for 30 minutes afterwards (disabled when
the update changed the database schema, since migrations are forward-only).

Two requirements:

1. The process must be **restarted automatically on exit** — e.g. a systemd unit
   with `Restart=always`, or pm2. Without that, the update builds but the server
   stays down. (Docker deploys update by pulling a new image, not via this button.)
2. A **private** repo needs a read deploy-key on the server for the background
   `git fetch` to work.

The first time, **dry-run it on a throwaway clone** rather than production:

```bash
git clone <your-repo> /tmp/taberno-dryrun && cd /tmp/taberno-dryrun
git reset --hard HEAD~3                 # pretend we're a few commits behind
git pull --ff-only origin master && npm install && npm run build && echo "clean update ✓"
```

Manual equivalent if you'd rather not use the button:
`git pull --ff-only && npm install && npm run build`, then restart the service.

## Docker

```bash
docker compose up
```

Multi-stage build: compiles in a build stage, ships only compiled output and production `node_modules`. A volume is mounted for `/data` (the database). Uploaded images under `/app/uploads` aren't persisted across container recreation unless you add a volume for that path too.

## Project structure

- `src/routes/` - Fastify routes: `storefront/`, `admin/`, `api/`
- `src/commerce/` - products, collections, cart, orders
- `src/theme/` - Handlebars engine, helpers, context builders
- `src/email/` - transactional email transports and templates
- `src/db/migrations/` - SQL migration files, applied on boot
- `themes/linen/` - bundled default theme
- `admin/` - admin panel Handlebars templates

See [theme_engine_spec.md](theme_engine_spec.md) for the full technical spec.
