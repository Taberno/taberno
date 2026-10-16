import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import config from '../../src/config';
import { execute, query } from '../../src/db/connection';
import { setSetting } from '../../src/db/queries/admin';
import { createZone } from '../../src/db/queries/shipping';
import { syncCatalogue } from '../../src/atproto/sync';
import { COLLECTIONS } from '../../src/atproto/records';
import { validateRecord } from '../../src/atproto/validate';
import * as state from '../../src/atproto/state';
import { setRepoFactory, syncNow, idle } from '../../src/atproto/scheduler';
import { FakeRepo } from './fake-repo';

const imageDirs: string[] = [];

function addProduct(o: { id?: string; title?: string; published?: number; sku?: string | null; price?: number; qty?: number } = {}) {
  const id = o.id ?? randomUUID();
  execute(
    `INSERT INTO products (id, title, slug, description, vendor, tags_text, published) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, o.title ?? 'Harbour at dusk', `slug-${id}`, '<p>A print.</p>', 'Southsea Press', 'print riso', o.published ?? 1],
  );
  execute(
    `INSERT INTO product_variants (id, product_id, title, price, sku, inventory_quantity, options) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), id, 'A3', o.price ?? 2500, o.sku === undefined ? 'SKU-' + id.slice(0, 8) : o.sku, o.qty ?? 3, '{"Size":"A3"}'],
  );
  return id;
}

async function addImage(productId: string, colour: string) {
  const rel = `products/atproto-test-${randomUUID()}`;
  const dir = path.join(config.uploadsDir, rel);
  fs.mkdirSync(dir, { recursive: true });
  imageDirs.push(dir);
  await sharp({ create: { width: 40, height: 30, channels: 3, background: colour } }).webp().toFile(path.join(dir, 'large.webp'));
  execute(
    'INSERT INTO product_images (id, product_id, original, thumbnail, medium, large) VALUES (?, ?, ?, ?, ?, ?)',
    [randomUUID(), productId, `/uploads/${rel}/original.webp`, `/uploads/${rel}/thumbnail.webp`, `/uploads/${rel}/medium.webp`, `/uploads/${rel}/large.webp`],
  );
}

beforeEach(() => {
  for (const t of ['product_images', 'product_variants', 'products', 'atproto_records', 'atproto_blobs', 'atproto_sync_runs', 'atproto_account', 'shipping_zones']) {
    execute(`DELETE FROM ${t}`);
  }
  setSetting('store_name', 'Southsea Prints');
  setSetting('store_currency', 'GBP');
  setSetting('store_url', 'https://shop.example.com');
});

afterAll(() => {
  for (const d of imageDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('syncCatalogue', () => {
  it('publishes the storefront, products and variants as valid, linked records', async () => {
    createZone('United Kingdom', ['GB']);
    addProduct({ title: 'Harbour at dusk' });
    const repo = new FakeRepo();
    const res = await syncCatalogue(repo);

    expect(res).toMatchObject({ created: 3, updated: 0, deleted: 0, skipped: [] });
    const [storefront] = repo.get(COLLECTIONS.storefront);
    expect(storefront).toMatchObject({ storeDid: repo.did, displayName: 'Southsea Prints', currencies: ['GBP'], website: 'https://shop.example.com' });
    expect(repo.records.has(`${COLLECTIONS.storefront}/self`)).toBe(true);

    const [product] = repo.get(COLLECTIONS.product);
    const [variant] = repo.get(COLLECTIONS.variant);
    expect(product).toMatchObject({ name: 'Harbour at dusk', status: 'active' });
    const productKey = [...repo.records.keys()].find((k) => k.startsWith(COLLECTIONS.product))!;
    expect(variant!.product).toBe(`at://${repo.did}/${productKey}`);
    for (const [k, r] of repo.records) expect(validateRecord(k.split('/')[0]!, r.value)).toBeNull();
  });

  it('writes nothing when nothing changed', async () => {
    addProduct();
    const repo = new FakeRepo();
    await syncCatalogue(repo);
    repo.takeWrites();
    const res = await syncCatalogue(repo);
    expect(repo.takeWrites()).toEqual([]);
    expect(res.unchanged).toBe(3);
    // A full run compares against the repo too, and still writes nothing.
    await syncCatalogue(repo, { full: true });
    expect(repo.takeWrites()).toEqual([]);
  });

  it('updates only the record that changed', async () => {
    const id = addProduct();
    const repo = new FakeRepo();
    await syncCatalogue(repo);
    repo.takeWrites();
    execute('UPDATE product_variants SET price = 3000 WHERE product_id = ?', [id]);
    await syncCatalogue(repo);
    const writes = repo.takeWrites();
    expect(writes.map((w) => [w.action, w.collection])).toEqual([['update', COLLECTIONS.variant]]);
    expect(repo.get(COLLECTIONS.variant)[0]!.unitAmount).toBe(3000);
  });

  it('removes unpublished products, variants first, and never publishes drafts', async () => {
    const id = addProduct();
    addProduct({ title: 'Draft', published: 0 });
    const repo = new FakeRepo();
    await syncCatalogue(repo);
    expect(repo.get(COLLECTIONS.product).map((p) => p.name)).toEqual(['Harbour at dusk']);
    repo.takeWrites();

    execute('UPDATE products SET published = 0 WHERE id = ?', [id]);
    const res = await syncCatalogue(repo);
    expect(res.deleted).toBe(2);
    expect(repo.takeWrites().map((w) => [w.action, w.collection])).toEqual([
      ['delete', COLLECTIONS.variant],
      ['delete', COLLECTIONS.product],
    ]);
    expect(repo.get(COLLECTIONS.product)).toEqual([]);
  });

  it('deleting a product deletes its records', async () => {
    const id = addProduct();
    const repo = new FakeRepo();
    await syncCatalogue(repo);
    execute('DELETE FROM products WHERE id = ?', [id]);
    await syncCatalogue(repo);
    expect(repo.get(COLLECTIONS.product)).toEqual([]);
    expect(repo.get(COLLECTIONS.variant)).toEqual([]);
  });

  it('does not churn when an import re-creates variants with new ids', async () => {
    const id = addProduct({ sku: 'HAD-A3' });
    const repo = new FakeRepo();
    await syncCatalogue(repo);
    repo.takeWrites();
    execute('DELETE FROM product_variants WHERE product_id = ?', [id]);
    execute(`INSERT INTO product_variants (id, product_id, title, price, sku, inventory_quantity, options) VALUES (?, ?, 'A3', 2500, 'HAD-A3', 3, '{"Size":"A3"}')`, [randomUUID(), id]);
    await syncCatalogue(repo);
    expect(repo.takeWrites()).toEqual([]);
  });

  it('recreates a record deleted from the repo elsewhere, with the same key', async () => {
    addProduct();
    const repo = new FakeRepo();
    await syncCatalogue(repo);
    const productKey = [...repo.records.keys()].find((k) => k.startsWith(COLLECTIONS.product))!;
    repo.records.delete(productKey);
    repo.takeWrites();
    await syncCatalogue(repo, { full: true });
    const writes = repo.takeWrites();
    expect(writes.map((w) => w.action)).toEqual(['create']);
    expect(repo.records.has(productKey)).toBe(true);
  });

  it('adopts an existing storefront and leaves records it did not write alone', async () => {
    const repo = new FakeRepo();
    repo.records.set(`${COLLECTIONS.storefront}/self`, { cid: 'x', value: { displayName: 'Old' } });
    repo.records.set(`${COLLECTIONS.product}/3zzzzzzzzzzzz`, { cid: 'y', value: { name: 'Made elsewhere' } });
    addProduct();
    const res = await syncCatalogue(repo);
    expect(res.untracked).toBe(1);
    expect(repo.get(COLLECTIONS.storefront)[0]!.displayName).toBe('Southsea Prints');
    expect(repo.records.has(`${COLLECTIONS.product}/3zzzzzzzzzzzz`)).toBe(true);
  });

  it('retries once against a fresh listing when a batch is rejected', async () => {
    addProduct();
    const repo = new FakeRepo();
    repo.failNextWrite = true;
    const res = await syncCatalogue(repo);
    expect(res.created).toBe(3);
    expect(repo.get(COLLECTIONS.product)).toHaveLength(1);
  });

  it('uploads each image file once, even when an import gives it a new row', async () => {
    const id = addProduct();
    await addImage(id, '#336699');
    const repo = new FakeRepo();
    await syncCatalogue(repo);
    expect(repo.uploads).toBe(1);
    const images = repo.get(COLLECTIONS.product)[0]!.images as { mimeType: string }[];
    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe('image/webp');

    // Same file referenced from a re-created image row: no new upload, no write.
    const row = query<{ large: string }>('SELECT large FROM product_images WHERE product_id = ?', [id])[0]!;
    execute('DELETE FROM product_images WHERE product_id = ?', [id]);
    execute('INSERT INTO product_images (id, product_id, original, thumbnail, medium, large) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), id, row.large, row.large, row.large, row.large]);
    repo.takeWrites();
    await syncCatalogue(repo);
    expect(repo.uploads).toBe(1);
    expect(repo.takeWrites()).toEqual([]);
  });

  it('keeps records per account, so switching accounts republishes everything', async () => {
    addProduct();
    await syncCatalogue(new FakeRepo('did:plc:firstaaaaaaaaaaaaaaaaaaa'));
    const second = new FakeRepo('did:plc:secondaaaaaaaaaaaaaaaaaa');
    const res = await syncCatalogue(second);
    expect(res.created).toBe(3);
  });
});

describe('scheduler', () => {
  it('records completed and failed runs', async () => {
    addProduct();
    state.saveAccount('did:plc:fakeshopaaaaaaaaaaaaaaaa', 'shop.example.com');
    const repo = new FakeRepo();
    setRepoFactory(async () => repo);
    await syncNow('manual', true);
    await idle();
    expect(state.recentRuns(1)[0]).toMatchObject({ trigger: 'manual', status: 'completed', created: 3 });

    setRepoFactory(async () => {
      throw new Error('Reconnect needed: session expired');
    });
    await syncNow('hourly', true);
    await idle();
    expect(state.recentRuns(1)[0]).toMatchObject({ trigger: 'hourly', status: 'failed', message: 'Reconnect needed: session expired' });
    setRepoFactory(null);
  });

  it('closes out runs left running by a restart', () => {
    state.startRun('hourly');
    state.failStaleRuns();
    expect(state.recentRuns(1)[0]).toMatchObject({ status: 'failed', message: 'interrupted' });
  });
});
