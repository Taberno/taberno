import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import config from '../config';
import { query } from '../db/connection';
import { getAllSettings } from '../db/queries/admin';
import { findAllZones } from '../db/queries/shipping';
import { storeUrl } from '../store-url';
import {
  COLLECTIONS,
  buildProduct,
  buildStorefront,
  buildVariant,
  recordHash,
  variantKey,
  type AtRecord,
  type BlobRef,
  type Collection,
  type ProductInput,
  type VariantInput,
} from './records';
import type { RepoClient, Write } from './repo';
import { nextTid } from './tid';
import { validateRecord } from './validate';
import * as state from './state';

// Reconciliation: build the records the catalogue should produce, compare
// them with what was last published, and write only the difference. Running
// it twice in a row writes nothing. Drafts never leave the store: a product
// that is unpublished or deleted has its records deleted.

const BATCH = 200;
const MAX_IMAGES = 8;
const MAX_BLOB_BYTES = 1_000_000;

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  skipped: { key: string; error: string }[];
  /** Records in our collections on the repo that this store did not write. Left alone. */
  untracked: number;
}

interface Desired {
  key: string;
  collection: Collection;
  rkey: string;
  record: AtRecord;
  hash: string;
}

type Pending = Write & { key: string; hash?: string };

interface ImageRow {
  product_id: string;
  large: string;
}

const COLLECTION_ORDER: Record<string, number> = {
  [COLLECTIONS.storefront]: 0,
  [COLLECTIONS.product]: 1,
  [COLLECTIONS.variant]: 2,
};

/** Resolves a public /uploads/... path to a file inside the uploads dir, or null. */
function uploadsFile(publicPath: string): string | null {
  const rel = publicPath.replace(/^\/uploads\//, '');
  if (rel === publicPath) return null;
  const root = path.resolve(config.uploadsDir);
  const file = path.resolve(root, rel);
  return file.startsWith(root + path.sep) && fs.existsSync(file) ? file : null;
}

/** Uploads an image once per distinct file, shrinking it under the 1 MB record limit if needed. */
async function ensureBlob(repo: RepoClient, publicPath: string | null | undefined): Promise<BlobRef | null> {
  if (!publicPath) return null;
  const file = uploadsFile(publicPath);
  if (!file) return null;
  const input = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  const cached = state.getBlob(repo.did, hash) as BlobRef | null;
  if (cached) return cached;

  let data: Buffer = input;
  let mimeType = `image/${(await sharp(input).metadata()).format ?? 'webp'}`.replace('image/jpg', 'image/jpeg');
  for (let quality = 80; data.byteLength > MAX_BLOB_BYTES && quality >= 40; quality -= 15) {
    data = await sharp(input).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality }).toBuffer();
    mimeType = 'image/webp';
  }
  if (data.byteLength > MAX_BLOB_BYTES) return null;
  const blob = await repo.uploadBlob(data, mimeType);
  state.saveBlob(repo.did, hash, blob);
  return blob;
}

async function buildDesired(repo: RepoClient, rows: Map<string, state.RecordRow>, today?: string): Promise<{ desired: Desired[]; skipped: SyncResult['skipped'] }> {
  const settings = getAllSettings();
  const base = storeUrl(settings);
  const currency = settings.store_currency || 'GBP';
  const desired: Desired[] = [];
  const skipped: SyncResult['skipped'] = [];
  const add = (key: string, collection: Collection, rkey: string, record: AtRecord): boolean => {
    const error = validateRecord(collection, record);
    if (error) {
      skipped.push({ key, error });
      return false;
    }
    desired.push({ key, collection, rkey, record, hash: recordHash(record) });
    return true;
  };

  add(
    'storefront',
    COLLECTIONS.storefront,
    'self',
    buildStorefront({
      did: repo.did,
      name: settings.store_name || 'Shop',
      tagline: settings.store_tagline || null,
      currency,
      url: base,
      zones: findAllZones().map((z) => ({ id: z.id, name: z.name, countries: parseCountries(z.countries) })),
      logo: await ensureBlob(repo, settings.store_logo),
    }),
  );

  const products = query<ProductInput>(
    `SELECT id, title, slug, description, vendor, tags_text, is_digital, available_from, available_until,
            allow_preorder, created_at, updated_at
     FROM products WHERE published = 1 ORDER BY created_at, id`,
  );
  const variants = new Map<string, VariantInput[]>();
  for (const v of query<VariantInput & { product_id: string }>(
    'SELECT id, product_id, title, price, sku, inventory_quantity, options, position FROM product_variants ORDER BY position, id',
  )) {
    variants.set(v.product_id, [...(variants.get(v.product_id) ?? []), v]);
  }
  const images = new Map<string, ImageRow[]>();
  for (const img of query<ImageRow>('SELECT product_id, large FROM product_images ORDER BY position, id')) {
    images.set(img.product_id, [...(images.get(img.product_id) ?? []), img]);
  }

  for (const p of products) {
    const productKey = `product:${p.id}`;
    const productRkey = rows.get(productKey)?.rkey ?? nextTid();
    const productUri = `at://${repo.did}/${COLLECTIONS.product}/${productRkey}`;
    const pv = variants.get(p.id) ?? [];
    const blobs: BlobRef[] = [];
    for (const img of (images.get(p.id) ?? []).slice(0, MAX_IMAGES)) {
      const blob = await ensureBlob(repo, img.large);
      if (blob) blobs.push(blob);
    }
    // A product that fails validation takes its variants with it: they would
    // point at a record that does not exist.
    if (!add(productKey, COLLECTIONS.product, productRkey, buildProduct(p, pv, blobs, base))) continue;
    const seen = new Set<string>();
    for (const v of pv) {
      const key = variantKey(p.id, v);
      if (seen.has(key)) continue; // two variants with the same SKU: publish the first
      seen.add(key);
      add(key, COLLECTIONS.variant, rows.get(key)?.rkey ?? nextTid(), buildVariant(v, p, productUri, currency, today));
    }
  }
  return { desired, skipped };
}

function parseCountries(json: string | string[]): string[] {
  if (Array.isArray(json)) return json;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export async function syncCatalogue(
  repo: RepoClient,
  opts: { full?: boolean; today?: string; retried?: boolean } = {},
): Promise<SyncResult> {
  const did = repo.did;
  const rows = new Map(state.recordRows(did).map((r) => [r.local_key, r]));
  // Compare with the repo itself on a full run, and always on the first.
  const full = opts.full || rows.size === 0;

  const missing = new Set<string>();
  let remoteSelf = false;
  let untracked = 0;
  if (full) {
    const tracked = new Set([...rows.values()].map((r) => `${r.collection}/${r.rkey}`));
    const remote = new Set<string>();
    for (const collection of Object.values(COLLECTIONS)) {
      for (const r of await repo.listRecords(collection)) {
        const rkey = r.uri.split('/').pop()!;
        remote.add(`${collection}/${rkey}`);
        if (collection === COLLECTIONS.storefront && rkey === 'self') remoteSelf = true;
        else if (!tracked.has(`${collection}/${rkey}`)) untracked++;
      }
    }
    for (const r of rows.values()) if (!remote.has(`${r.collection}/${r.rkey}`)) missing.add(r.local_key);
  }

  const { desired, skipped } = await buildDesired(repo, rows, opts.today);
  const wanted = new Set(desired.map((d) => d.key));
  const keep = new Set(skipped.map((s) => s.key)); // invalid now: leave what is published alone

  const upserts: Pending[] = [];
  let unchanged = 0;
  for (const d of desired) {
    const row = rows.get(d.key);
    const exists = row ? !missing.has(d.key) : d.key === 'storefront' && remoteSelf;
    if (row && exists && row.hash === d.hash) {
      unchanged++;
      continue;
    }
    upserts.push({ action: exists ? 'update' : 'create', collection: d.collection, rkey: d.rkey, value: d.record, key: d.key, hash: d.hash });
  }
  upserts.sort((a, b) => COLLECTION_ORDER[a.collection]! - COLLECTION_ORDER[b.collection]!);

  const deletes: Pending[] = [];
  for (const row of rows.values()) {
    if (wanted.has(row.local_key) || keep.has(row.local_key)) continue;
    if (missing.has(row.local_key)) {
      state.deleteRecordRow(did, row.local_key); // already gone from the repo
      continue;
    }
    deletes.push({ action: 'delete', collection: row.collection, rkey: row.rkey, key: row.local_key });
  }
  // Variants before the products they point at.
  deletes.sort((a, b) => COLLECTION_ORDER[b.collection]! - COLLECTION_ORDER[a.collection]!);

  const writes = [...deletes, ...upserts];
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, unchanged, skipped, untracked };
  for (let i = 0; i < writes.length; i += BATCH) {
    const batch = writes.slice(i, i + BATCH);
    let cids: (string | null)[];
    try {
      cids = await repo.applyWrites(batch.map(({ key: _key, hash: _hash, ...w }) => w as Write));
    } catch (err) {
      // Our view of the repo, or of its blobs, is out of date (edited
      // elsewhere, or an uploaded blob was garbage-collected before use).
      // Forget cached blobs and retry once against a fresh listing.
      if (opts.retried) throw err;
      state.forgetBlobs(did);
      return syncCatalogue(repo, { ...opts, full: true, retried: true });
    }
    batch.forEach((w, j) => {
      if (w.action === 'delete') {
        state.deleteRecordRow(did, w.key);
        result.deleted++;
      } else {
        state.upsertRecordRow(did, w.key, w.collection, w.rkey, w.hash!, cids[j] ?? null);
        if (w.action === 'create') result.created++;
        else result.updated++;
      }
    });
  }
  return result;
}
