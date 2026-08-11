import 'dotenv/config';
import path from 'path';

const DEV_DEFAULT_SESSION_SECRET = 'dev-secret-change-in-production-min32chars!';
// Known placeholder values ever shipped in this repo (config.ts's own
// fallback, plus .env.example's) — all equally public/guessable, so all must
// be rejected in production, not just whichever one config.ts happens to
// default to internally.
const KNOWN_PLACEHOLDER_SECRETS = new Set([DEV_DEFAULT_SESSION_SECRET, 'change-me-in-production']);

const databasePath = path.resolve(process.cwd(), process.env.DATABASE_PATH || 'data/store.db');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
  themeDir: path.resolve(process.cwd(), process.env.THEME_DIR || 'themes/linen'),
  uploadsDir: path.resolve(process.cwd(), process.env.UPLOADS_DIR || 'uploads'),
  sessionSecret: process.env.SESSION_SECRET || DEV_DEFAULT_SESSION_SECRET,
  databasePath,
  // Deliberately NOT under uploadsDir — that whole tree is served publicly,
  // unauthenticated, by @fastify/static (see server.ts). Digital product
  // files must only ever be reachable through the signed, expiring
  // /downloads/:token route, never a raw static path. Defaults to living
  // next to the database so it's covered by the same persistent volume
  // without any extra Docker/compose configuration.
  digitalFilesDir: process.env.DIGITAL_FILES_DIR
    ? path.resolve(process.cwd(), process.env.DIGITAL_FILES_DIR)
    : path.join(path.dirname(databasePath), 'digital-files'),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
  paypalMode: (process.env.PAYPAL_MODE || 'sandbox') as 'sandbox' | 'live',

  // ── Managed hosting (Squaark Cloud) ──────────────────────────────────────
  // Set by the control plane in a managed store's .env. A self-hosted install
  // leaves these unset and behaves exactly as before.
  cloudMode: process.env.CLOUD_MODE === 'true',
  /**
   * Shared secret the control plane presents to GET /api/usage, as
   * X-Cloud-Secret. CLOUD_INTERNAL_TOKEN is the name an earlier control-plane
   * release wrote; accepted so a store provisioned before the rename keeps
   * reporting usage until its .env is refreshed.
   */
  cloudSecret: process.env.CLOUD_SECRET || process.env.CLOUD_INTERNAL_TOKEN || '',
  /**
   * Per-store secret the control plane signs a one-time admin-handoff token
   * with (the `t` on GET /admin/cloud-session). Deliberately NOT cloudSecret:
   * that value is shared by every store on the box, so a handoff token signed
   * with it would be valid at every other tenant's shop. Unset on a self-hosted
   * install — where the handoff route does not exist at all — and never falls
   * back to cloudSecret or a default.
   */
  cloudAuthSecret: process.env.CLOUD_AUTH_SECRET || '',
  /**
   * This store's id in the control plane (e.g. "store-abc123"), set in the
   * managed .env. Used to reject an admin-handoff token minted for a different
   * store, the check that saves us if a per-store secret is ever reused.
   */
  storeId: process.env.STORE_ID || '',
  /** Staff-account cap for the store's plan. 0 means no cap. */
  staffLimit: parseInt(process.env.STAFF_LIMIT || process.env.CLOUD_MAX_STAFF || '0', 10) || 0,
  /**
   * The store's public URL, set by the control plane.
   *
   * Overrides the `store_url` setting when present: on managed hosting the
   * control plane owns the address — it is the thing that assigned the
   * subdomain and verified the custom domain — so a stale value typed into
   * Settings must not win and start signing download links for the wrong host.
   */
  storeUrl: (process.env.STORE_URL || '').replace(/\/$/, ''),
  /**
   * The Squaark Cloud account that owns this store.
   *
   * Used to pre-fill the one first-run step that cannot be skipped — creating
   * the admin login. The control plane cannot create it for them: it holds an
   * argon2 hash of the dashboard password, not the password, and reusing one
   * credential across two systems would be worse than asking once.
   */
  cloudOwnerEmail: process.env.CLOUD_OWNER_EMAIL || '',
  cloudOwnerName: process.env.CLOUD_OWNER_NAME || '',
};

// Every placeholder here is checked into this open-source repo, so anyone
// who's read the source could forge session cookies / CSRF tokens for any
// deployment that forgot to override it. Fail loudly rather than silently
// running an internet-facing store with a publicly-known signing secret.
if (config.nodeEnv === 'production' && (!process.env.SESSION_SECRET || KNOWN_PLACEHOLDER_SECRETS.has(config.sessionSecret))) {
  throw new Error(
    'SESSION_SECRET is not set (or is still a placeholder value from this repo) while ' +
    'NODE_ENV=production. Set a strong, random SESSION_SECRET before running in production — ' +
    'generate one with `openssl rand -hex 32`.',
  );
}

export default config;
