import { describe, it, expect, afterEach, vi } from 'vitest';
import Handlebars from 'handlebars';
import fs from 'fs';
import path from 'path';

/**
 * Applies an environment overlay, deleting keys explicitly set to undefined.
 *
 * `process.env.FOO = undefined` stores the STRING "undefined", which is truthy
 * and would make "unset" cases silently assert the wrong thing.
 */
function applyEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadConfig(env: Record<string, string | undefined>) {
  const previous = { ...process.env };
  applyEnv(env);
  vi.resetModules();
  const mod = (await import('../src/config')).default;
  process.env = previous;
  return mod;
}

/** Renders an admin template with the helpers registered, as render.ts does. */
function renderAdmin(template: string, context: Record<string, unknown>): string {
  const hbs = Handlebars.create();
  for (const name of [
    'ne', 'or', 'not', 'gt', 'lt', 'add', 'subtract', 'concat', 'money_pence', 'pence',
    'date_short', 'truncate', 'percent', 'parseJson', 'jsonParse', 'jsonLength',
    'jsonNonEmpty', 'isSelected', 'stars', 'json_pretty', 'hasNonImageFields',
    'csrf_field', 'status_badge', 'delta_badge', 'revenue_bars', 'sparkline_bars', 'lookup',
  ]) hbs.registerHelper(name, () => '');
  hbs.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  hbs.registerHelper('and', (a: unknown, b: unknown) => a && b);
  hbs.registerHelper('not', (a: unknown) => !a);

  const src = fs.readFileSync(path.resolve(process.cwd(), 'admin', `${template}.hbs`), 'utf-8');
  return hbs.compile(src)(context);
}

afterEach(() => vi.resetModules());

describe('config', () => {
  it('is off unless CLOUD_MODE is exactly "true"', async () => {
    expect((await loadConfig({ CLOUD_MODE: undefined })).cloudMode).toBe(false);
    expect((await loadConfig({ CLOUD_MODE: '1' })).cloudMode).toBe(false);
    expect((await loadConfig({ CLOUD_MODE: 'true' })).cloudMode).toBe(true);
  });

  it('reads STAFF_LIMIT, falling back to the earlier name', async () => {
    expect((await loadConfig({ STAFF_LIMIT: '10' })).staffLimit).toBe(10);
    // A store provisioned before the rename keeps its cap until reprovisioned.
    expect((await loadConfig({ STAFF_LIMIT: undefined, CLOUD_MAX_STAFF: '2' })).staffLimit).toBe(2);
    // Unset means no cap at all, which is what self-hosted installs get.
    expect((await loadConfig({ STAFF_LIMIT: undefined, CLOUD_MAX_STAFF: undefined })).staffLimit).toBe(0);
  });
});

describe('settings page', () => {
  const context = (cloudMode: boolean) => ({
    cloudMode, settings: {}, updateJob: {},
    update: { updateAvailable: true, behind: 3 }, revert: { available: true },
  });

  it('hides SMTP configuration on managed hosting', () => {
    // Email is configured at the cloud level by the control plane; letting a
    // merchant point their store at their own SMTP would silently break the
    // deliverability the platform is responsible for.
    const cloud = renderAdmin('settings', context(true));
    expect(cloud).not.toContain('name="smtp_host"');
    expect(cloud).not.toContain("tab = 'email'");

    const self = renderAdmin('settings', context(false));
    expect(self).toContain('name="smtp_host"');
    expect(self).toContain("tab = 'email'");
  });

  it('keeps the email LOG visible — it is diagnostics, not configuration', () => {
    expect(renderAdmin('settings', context(true))).toContain("section = 'email'");
  });

  it('shows version info but no in-app self-update action', () => {
    const cloud = renderAdmin('settings', context(true));
    expect(cloud).not.toContain('Update now');
    expect(cloud).not.toContain('Revert to previous');
    expect(cloud).toContain('keeps this store up to date');

    // Self-hosted: surfaces that a new version exists, but there's no in-app
    // "Update now"/"Revert" button — updating is done via the deployment.
    const self = renderAdmin('settings', context(false));
    expect(self).not.toContain('Update now');
    expect(self).not.toContain('Revert to previous');
    expect(self).toContain('A new version is available');
  });
});

describe('import page', () => {
  it('replaces backup/transfer with a pointer to the dashboard', () => {
    const cloud = renderAdmin('import', { cloudMode: true, job: {} });
    expect(cloud).not.toContain('backup &amp; transfer');
    expect(cloud).toContain('cloud.squaark.com');

    expect(renderAdmin('import', { cloudMode: false, job: {} })).toContain('backup &amp; transfer');
  });
});

describe('admin layout', () => {
  const context = (cloudMode: boolean) => ({
    cloudMode, admin: { name: 'Matt' }, settings: {},
    update: { updateAvailable: true, behind: 2 }, body: '',
  });

  it('shows the hosted-by link only on managed hosting', () => {
    expect(renderAdmin('partials/layout', context(true))).toContain('Hosted by Squaark Cloud');
    expect(renderAdmin('partials/layout', context(false))).not.toContain('Hosted by Squaark Cloud');
  });

  it('hides the update banner, which a merchant cannot act on', () => {
    expect(renderAdmin('partials/layout', context(true))).not.toContain('An update is available');
    expect(renderAdmin('partials/layout', context(false))).toContain('An update is available');
  });
});

describe('users page', () => {
  it('disables Add user and explains why at the limit', () => {
    const atLimit = renderAdmin('users/list', { atStaffLimit: true, users: [], admin: {}, settings: {} });
    expect(atLimit).toContain('Staff account limit reached');
    expect(atLimit).toContain('disabled title');

    const under = renderAdmin('users/list', { atStaffLimit: false, users: [], admin: {}, settings: {} });
    expect(under).not.toContain('Staff account limit reached');
    expect(under).not.toContain('disabled title');
  });
});

describe('setup page', () => {
  it('reframes the copy on managed hosting', () => {
    const cloud = renderAdmin('setup', { cloudMode: true, values: { email: 'a@b.test', name: 'A' } });
    // Not a first-run wizard: everything else is already configured, and this
    // is the one step the control plane cannot do for them.
    expect(cloud).toContain("Choose a password for your shop's admin");
    expect(cloud).toContain('value="a@b.test"');

    expect(renderAdmin('setup', { cloudMode: false, values: {} }))
      .toContain('Create your admin account');
  });
});

describe('self-update route', () => {
  it('refuses in cloud mode, not merely hides the button', async () => {
    // Every managed store runs from ONE shared checkout, so a merchant pulling
    // a new build would swap the code under every other tenant on the box.
    // Hiding a button does not stop a POST.
    const previous = { ...process.env };
    applyEnv({ CLOUD_MODE: 'true' });
    vi.resetModules();

    const Fastify = (await import('fastify')).default;
    const { settingsRoutes } = await import('../src/routes/admin/settings');

    const app = Fastify();
    await app.register(settingsRoutes);
    await app.ready();

    try {
      const res = await app.inject({ method: 'POST', url: '/settings/update' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain('Squaark Cloud');

      const revert = await app.inject({ method: 'POST', url: '/settings/revert' });
      expect(revert.statusCode).toBe(403);
    } finally {
      await app.close();
      process.env = previous;
    }
  });
});
