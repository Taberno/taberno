import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execute } from '../src/db/connection';

/**
 * Loads store-url.ts with a given environment.
 *
 * config.ts snapshots process.env at import, so the module graph has to be
 * dropped between cases to exercise both the managed and self-hosted paths.
 */
/**
 * Applies an environment overlay, deleting keys explicitly set to undefined.
 *
 * `process.env.FOO = undefined` stores the STRING "undefined", which is truthy
 * and would make "unset" tests silently assert the wrong thing.
 */
function applyEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadStoreUrl(env: Record<string, string | undefined>) {
  const previous = { ...process.env };
  applyEnv(env);

  vi.resetModules();
  const mod = await import('../src/store-url');

  process.env = previous;
  return mod;
}

function setSetting(value: string | null): void {
  execute("DELETE FROM store_settings WHERE key = 'store_url'");
  if (value !== null) {
    execute("INSERT INTO store_settings (key, value) VALUES ('store_url', ?)", [value]);
  }
}

beforeEach(() => setSetting(null));
afterEach(() => vi.resetModules());

describe('storeUrl', () => {
  it('falls back to localhost when nothing is configured', async () => {
    const { storeUrl } = await loadStoreUrl({ STORE_URL: undefined });

    expect(storeUrl()).toBe('http://localhost:3000');
  });

  it('uses the store_url setting when STORE_URL is unset', async () => {
    const { storeUrl } = await loadStoreUrl({ STORE_URL: undefined });
    setSetting('https://shop.example.com');

    expect(storeUrl()).toBe('https://shop.example.com');
  });

  it('strips a trailing slash from the setting', async () => {
    const { storeUrl } = await loadStoreUrl({ STORE_URL: undefined });
    setSetting('https://shop.example.com/');

    // Callers concatenate paths straight onto this; a trailing slash produces
    // https://shop.example.com//products.
    expect(storeUrl()).toBe('https://shop.example.com');
  });

  it('lets STORE_URL override the setting', async () => {
    const { storeUrl } = await loadStoreUrl({ STORE_URL: 'https://acme.taberno.io' });
    setSetting('https://stale-old-address.example.com');

    // On managed hosting the control plane assigned the address and verified
    // the domain; a stale value left in Settings must not win and start
    // putting the wrong host into canonical tags and signed download links.
    expect(storeUrl()).toBe('https://acme.taberno.io');
  });

  it('strips a trailing slash from STORE_URL too', async () => {
    const { storeUrl } = await loadStoreUrl({ STORE_URL: 'https://acme.taberno.io/' });

    expect(storeUrl()).toBe('https://acme.taberno.io');
  });

  it('ignores an empty STORE_URL rather than blanking the URL', async () => {
    const { storeUrl } = await loadStoreUrl({ STORE_URL: '' });
    setSetting('https://shop.example.com');

    expect(storeUrl()).toBe('https://shop.example.com');
  });

  it('prefers settings passed in over reading them again', async () => {
    const { storeUrl } = await loadStoreUrl({ STORE_URL: undefined });
    setSetting('https://from-the-database.example.com');

    expect(storeUrl({ store_url: 'https://passed-in.example.com' }))
      .toBe('https://passed-in.example.com');
  });

  it('builds absolute paths', async () => {
    const { storeUrlFor } = await loadStoreUrl({ STORE_URL: 'https://acme.taberno.io' });

    expect(storeUrlFor('/products/mug')).toBe('https://acme.taberno.io/products/mug');
    expect(storeUrlFor('products/mug')).toBe('https://acme.taberno.io/products/mug');
  });
});
