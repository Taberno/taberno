# Module architecture (Phase 0 design)

> Status: **proposal, for review.** No code has moved yet. This describes the
> module *boundary* — the contract, registry, migration and gating model — that
> lets taberno grow as toggleable first-party modules and, later, graduate the
> same boundary into a third-party plugin API.

## Why

Taberno is heading toward a **hosted, multi-tenant SaaS** on a **DB-per-tenant**
model (one SQLite file per store). We want features that can be:

- **decluttered** — a store only sees what it uses;
- **optional/heavy** — big features stay out of the default footprint;
- **plan-gated** — features tie to pricing tiers (entitlements);
- **eventually third-party** — outside developers ship modules.

The first three are served by a **modular-monolith + per-store entitlements**:
one deployable artifact, features gated per store. Only the fourth needs a real
plugin *runtime*, and that's deferred. The bet of Phase 0 is: **design the module
boundary now so the runtime becomes an extension, not a rewrite.**

Non-goals for Phase 0 (deferred): the plugin runtime itself (sandboxing, signing,
a versioned public API, marketplace), the hosting control plane (provisioning,
custom domains/TLS, billing), and splitting heavy modules into separate services.

## Core vs. module

Not everything should be a module. Drawing the line keeps ceremony where it pays
off:

- **Core (always on, not modules):** products, collections, cart, checkout,
  orders, customers, settings, themes, navigation. Every store needs these;
  modularising them is cost with no benefit.
- **Modules (optional, entitlement-gated):** Promotions (discount codes +
  banners), Import/Export, and — later — Reviews, Subscriptions, Analytics, POS,
  etc. Pages/CMS and Tax are candidates but can stay core initially.

Phase 0 converts **exactly one** feature — **Promotions** — to prove the
contract end-to-end. Everything else stays as-is until the pattern earns its keep.

## The contract: `TabernoModule`

A module is a self-contained folder under `src/modules/<id>/` exporting a manifest:

```ts
export interface TabernoModule {
  /** Stable identifier; also the migration namespace and entitlement key. */
  id: string;                          // e.g. 'promotions'
  name: string;                        // 'Promotions'
  description: string;
  /** Shown/hidden in admin; drives entitlement mapping later. */
  defaultEnabled: boolean;             // policy when a store has no explicit state
  /** Other module ids that must be enabled first (migrations + registration order). */
  dependencies?: string[];

  /** Module-owned schema, applied against the tenant DB when enabled. */
  migrations?: string[];               // filenames in src/modules/<id>/migrations/

  /** Admin surface: routes + views. Registered inside an encapsulated scope. */
  registerAdmin?(fastify: FastifyInstance): Promise<void> | void;
  /** Sidebar entries contributed to the admin layout. */
  adminNav?: AdminNavItem[];

  /** Storefront routes (e.g. a reviews endpoint). */
  registerStorefront?(fastify: FastifyInstance, registry: ThemeRegistry): Promise<void> | void;
  /** Add to the per-request storefront context (like the banner does today). */
  contributeContext?(ctx: GlobalContext, req: FastifyRequest): void;
}

export interface AdminNavItem {
  label: string;
  href: string;
  section: string;                     // matches pageSection for active-state
  icon?: string;                       // inline SVG path data
}
```

Design notes:

- **`id` is the one string that ties everything together** — folder name,
  migration namespace, entitlement key, and `pageSection` prefix. One source of
  truth.
- The manifest is **data + registration callbacks**, nothing more. That keeps it
  trivially serialisable later for a public API description, and keeps a module's
  code reachable by direct call today (first-party = no sandbox needed yet).
- Callbacks receive the **existing** Fastify/registry/context objects — modules
  use the same primitives core does, so there's no second-class "plugin API" to
  maintain in parallel.

## The registry

A single `src/modules/registry.ts` imports every module manifest into a static
catalog (Phase 0: an explicit array — no dynamic filesystem discovery, which is a
plugin-runtime concern):

```ts
import { promotions } from './promotions/module';
export const MODULES: TabernoModule[] = [promotions];
```

Responsibilities:

- **Catalog** — the code-defined set of modules this build ships.
- **Ordering** — topologically sort by `dependencies` for migration + registration.
- **Enablement** — resolve which modules are on for the current store (see below).
- **Wiring** — call `registerAdmin` / `registerStorefront` for registered modules;
  collect `adminNav` and `contributeContext` hooks.

## Enablement & gating

**Where enabled state lives (per tenant DB):** a `modules` table.

```sql
CREATE TABLE modules (
  id          TEXT PRIMARY KEY,        -- module id
  enabled     INTEGER NOT NULL,
  updated_at  TEXT DEFAULT (datetime('now'))
);
```

On boot the registry **reconciles**: for each catalog module with no row, insert
one with `enabled = defaultEnabled`. `enabled` is what an admin toggles today;
in Phase 1 a **plan → module-set entitlement** computes/overrides it (a store
can only enable what its plan allows).

**How gating is enforced (recommended: always-register + guard):**

- Module admin/storefront routes are **always registered** at boot, inside an
  encapsulated scope with a `preHandler` that 404s/redirects when the module is
  disabled for the current store. This mirrors how `tax_enabled` /
  `customer_accounts_enabled` already gate features, and lets an admin toggle a
  module **without a restart**.
- **Admin nav** is filtered to enabled modules — the registry passes a
  `moduleNav` list into the admin render context; the layout renders core links
  then module links. (Core nav stays hardcoded for now; we don't rip out working
  markup.)
- **Storefront** `contributeContext` hooks run only for enabled modules, so a
  disabled module contributes nothing to the page (e.g. no banner).

> Alternative considered: **boot-time registration** (register only enabled
> modules; toggling needs a restart). Cleaner footprint, and a natural fit once
> we're **instance-per-tenant** in hosting. Recommendation: ship the guard model
> in Phase 0 (works in one shared process, no restarts), and revisit boot-time
> registration when the control plane makes per-tenant restarts cheap.

## Migrations

Today: `src/db/migrations/NNN_*.sql`, applied in filename order, tracked by
`filename` in a `migrations` table, forward-only ([src/db/migrate.ts](../src/db/migrate.ts)).

Change: **namespace migrations by module.** Add a `module` column to the tracking
table (existing rows backfilled to `'core'`), and let the runner apply:

1. all `core` migrations (the current `src/db/migrations/` set), then
2. for each **enabled** module (in dependency order), the files in
   `src/modules/<id>/migrations/`, tracked as `(module, filename)`.

```sql
-- one-time: extend tracking
ALTER TABLE migrations ADD COLUMN module TEXT NOT NULL DEFAULT 'core';
```

Consequences, all of which fit DB-per-tenant cleanly:

- **Enable = run that module's pending migrations against this store's DB.**
  Disable = flip `enabled` off; **data stays dormant** (no down-migrations —
  consistent with forward-only). Re-enable is instant: migrations already
  recorded, tables intact.
- **No cross-module numbering collisions** — each module numbers its own files
  from `001`; ordering *between* modules comes from `dependencies`, not global
  `NNN`.
- Core keeps its exact current behaviour (it's just `module = 'core'`).

The runner becomes `applyMigrations(db, enabledModuleIds)`, called at tenant
boot/provision and again when a module is enabled.

## Reference module: Promotions

Promotions exercises every part of the contract, which is why it's the pilot:

| Contract piece        | Promotions maps to                                                        |
|-----------------------|---------------------------------------------------------------------------|
| `id`                  | `promotions`                                                              |
| `migrations`          | `026_discounts.sql`, `028_promo_banners.sql` → `src/modules/promotions/migrations/001_*, 002_*` |
| `registerAdmin`       | today's `discountRoutes` + `bannerRoutes` (the `/discounts` + `/banners` scopes) |
| `adminNav`            | the "Promotions" sidebar entry (`section: 'promotions'`)                  |
| `registerStorefront`  | discount validation/apply endpoints used by the cart                      |
| `contributeContext`   | the active-banner lookup now in `buildGlobalContext`                       |

Disabling Promotions would then: drop the Promotions nav item, 404
`/admin/discounts` + `/admin/banners`, stop injecting the banner, and cause the
cart to ignore discount codes — with the tables (and any saved codes/banners)
left untouched for re-enable.

Nothing about the storefront theme changes: the header partial keeps its
`{{#if banner}}` — it simply gets no banner in context when the module is off.

## Files Phase 0 touches

- **New:** `src/modules/types.ts` (the interface), `src/modules/registry.ts`,
  `src/modules/promotions/module.ts`, `src/modules/promotions/migrations/*`, and
  the Promotions code moved under `src/modules/promotions/` (routes, queries,
  views, tests).
- **Changed:** `src/db/migrate.ts` (namespaced runner + `applyMigrations`),
  `src/routes/admin/index.ts` (register modules via the registry),
  `src/routes/storefront/index.ts` + `src/theme/context.ts` (run
  `contributeContext` hooks instead of the hardcoded banner call),
  `admin/partials/layout.hbs` (render `moduleNav` after core links).
- **Removed/relocated:** `src/routes/admin/discounts.ts`, `banners.ts`, their
  queries, `admin/discounts/`, `admin/banners/`, `admin/partials/promo-tabs.hbs`
  → moved under the module (no behaviour change).

All incremental and non-breaking: after Phase 0, Promotions behaves exactly as
today, but through the module boundary — and it can be toggled off.

## Decisions needed before code

1. **Gating model:** always-register + `preHandler` guard (recommended, toggle
   without restart) vs. boot-time registration (cleaner, needs restart).
2. **Enabled-state storage:** a `modules` table (recommended) vs. a JSON blob in
   `store_settings`.
3. **First module:** confirm **Promotions** as the pilot (vs. Import/Export).
4. **Default policy:** confirm modules default to `enabled = defaultEnabled` with
   no plan layer in Phase 0 (entitlements arrive in Phase 1).
5. **Scope check:** agree that products/orders/customers/etc. stay **core** and
   are explicitly out of scope for modularisation now.

## Later phases (context, not Phase 0)

- **Phase 1 — Entitlements:** plan → module-set mapping; admin toggle bounded by
  plan; the seam for billing.
- **Phase 2 — Control plane:** DB-per-tenant provisioning, custom domains + TLS,
  fleet backups, rolling updates.
- **Phase 3 — Third-party:** freeze the manifest into a versioned public API, add
  sandboxing/signing/review, marketplace. Only here does the registry gain
  dynamic discovery.
