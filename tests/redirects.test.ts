import { describe, it, expect, beforeEach } from 'vitest';
import { execute, queryOne } from '../src/db/connection';
import {
  normalizeRedirectPath, permalinkToPath, isProtectedRedirectPath,
  recordImportRedirect, findRedirect, bumpRedirectHits,
  addManualRedirect, listRedirects, deleteRedirect,
} from '../src/db/queries/redirects';
import { upsertProduct, upsertPage } from '../src/import/woocommerce/mapper';
import type { NormalizedProduct, NormalizedPage } from '../src/import/woocommerce/types';

beforeEach(() => {
  for (const t of ['redirects', 'collection_products', 'collections', 'product_images', 'product_variants', 'products', 'pages']) {
    execute(`DELETE FROM ${t}`);
  }
});

describe('path normalisation', () => {
  it('lowercases, strips the trailing slash, keeps root', () => {
    expect(normalizeRedirectPath('/Product/Blue-Widget/')).toBe('/product/blue-widget');
    expect(normalizeRedirectPath('product/x')).toBe('/product/x'); // adds leading slash
    expect(normalizeRedirectPath('/')).toBe('/');
    expect(normalizeRedirectPath('')).toBe('/');
  });

  it('extracts a normalised path from a full permalink', () => {
    expect(permalinkToPath('https://old.example.com/product/blue-widget/')).toBe('/product/blue-widget');
    expect(permalinkToPath('/already/a/path/')).toBe('/already/a/path');
    expect(permalinkToPath('not a url')).toBeNull();
  });

  it('flags protected system prefixes', () => {
    for (const p of ['/admin', '/admin/anything', '/checkout', '/cart', '/api/x', '/webhooks/stripe']) {
      expect(isProtectedRedirectPath(p)).toBe(true);
    }
    expect(isProtectedRedirectPath('/product/x')).toBe(false);
    expect(isProtectedRedirectPath('/cartography')).toBe(false); // prefix-with-slash, not substring
  });
});

describe('recordImportRedirect', () => {
  it('refuses a self-referential loop', () => {
    recordImportRedirect('/same', '/same');
    expect(findRedirect(['/same'])).toBeNull();
  });

  it('is idempotent — re-running updates the target without duplicating or resetting hits', () => {
    recordImportRedirect('/product/x', '/products/x');
    const first = findRedirect(['/product/x'])!;
    bumpRedirectHits(first.id);
    bumpRedirectHits(first.id);

    // Re-import: slug changed, same old path.
    recordImportRedirect('/product/x', '/products/x-2');
    const rows = listRedirects().filter((r) => r.from_path === '/product/x');
    expect(rows).toHaveLength(1);            // no duplicate
    expect(rows[0].to_path).toBe('/products/x-2'); // destination updated
    expect(rows[0].hits).toBe(2);            // hit count preserved
  });
});

describe('findRedirect', () => {
  it('matches a path key and a query key, preferring the more specific', () => {
    recordImportRedirect('/product/x', '/products/x');
    recordImportRedirect('/?p=42', '/products/x');

    expect(findRedirect(['/product/x'])?.to_path).toBe('/products/x');
    expect(findRedirect(['/', '/?p=42'])?.from_path).toBe('/?p=42'); // longer key wins over '/'
    expect(findRedirect(['/nope'])).toBeNull();
  });
});

describe('addManualRedirect', () => {
  it('validates destination, self-loops, protected and root paths', () => {
    expect(addManualRedirect('/old', 'no-slash')).toEqual({ ok: false, error: expect.stringContaining('“/”') });
    expect(addManualRedirect('/loop', '/loop')).toMatchObject({ ok: false });
    expect(addManualRedirect('/admin/x', '/somewhere')).toMatchObject({ ok: false });
    expect(addManualRedirect('/', '/somewhere')).toMatchObject({ ok: false });
    expect(addManualRedirect('/Old-Page/', '/new-page')).toEqual({ ok: true });
    // Stored normalised.
    expect(findRedirect(['/old-page'])?.to_path).toBe('/new-page');
  });

  it('deletes', () => {
    addManualRedirect('/gone', '/here');
    const r = findRedirect(['/gone'])!;
    deleteRedirect(r.id);
    expect(findRedirect(['/gone'])).toBeNull();
  });
});

// ── Capture during import ─────────────────────────────────────────────────────

function product(over: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    wcId: 100, permalink: 'https://old.example.com/product/blue-widget/',
    title: 'Blue Widget', slug: 'blue-widget', description: '', sku: null,
    price: 10, compareAtPrice: null, stockQuantity: 5, published: true,
    categories: [], images: [], variations: [], ...over,
  };
}

function page(over: Partial<NormalizedPage> = {}): NormalizedPage {
  return {
    wcId: 200, permalink: 'https://old.example.com/about-us/',
    title: 'About', slug: 'about-us', content: '', excerpt: '', status: 'published', ...over,
  };
}

describe('import capture', () => {
  it('records a product permalink and its /?p=<id> form → the new product page', async () => {
    await upsertProduct(product());
    expect(findRedirect(['/product/blue-widget'])?.to_path).toBe('/products/blue-widget');
    expect(findRedirect(['/?p=100'])?.to_path).toBe('/products/blue-widget');
  });

  it('records a category’s /product-category/<slug> → the new collection page', async () => {
    await upsertProduct(product({ categories: [{ wcId: 7, name: 'Apparel', slug: 'apparel' }] }));
    expect(findRedirect(['/product-category/apparel'])?.to_path).toBe('/collections/apparel');
  });

  it('records a nested page permalink and its /?p=<id> form → the new flat page path', () => {
    // A nested Woo page (/company/about-us/) flattens to /about-us here.
    upsertPage(page({ permalink: 'https://old.example.com/company/about-us/' }));
    expect(findRedirect(['/company/about-us'])?.to_path).toBe('/about-us');
    expect(findRedirect(['/?p=200'])?.to_path).toBe('/about-us');
  });

  it('skips the permalink redirect when old and new paths are identical (top-level page)', () => {
    // /about-us → /about-us is a no-op loop; only the /?p= form is worth recording.
    upsertPage(page({ slug: 'about-us', permalink: 'https://old.example.com/about-us/' }));
    expect(listRedirects().find((r) => r.from_path === '/about-us')).toBeUndefined(); // loop skipped
    expect(findRedirect(['/?p=200'])?.to_path).toBe('/about-us');                      // id form still useful
  });

  it('re-running the import does not duplicate rows', async () => {
    await upsertProduct(product());
    await upsertProduct(product());
    expect(listRedirects().filter((r) => r.from_path === '/product/blue-widget')).toHaveLength(1);
  });
});
