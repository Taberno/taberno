import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { query, queryOne, execute, transaction } from '../../db/connection';
import config from '../../config';
import { importRemoteImage } from '../woocommerce/image-fetch';
import { parseCsv, looksLikeFormula } from './csv';
import { createImportJob, updateImportJobProgress, appendImportJobError, finishImportJob } from '../../db/queries/import';

// Column order of the export, and the headers the import recognises. One row per
// VARIANT; the product columns repeat on each variant row and `handle` (the
// product slug) groups them — the shape Woo and Shopify both use.
export const COLUMNS = [
  'handle', 'title', 'description', 'vendor', 'tags', 'published',
  'option_name_1', 'option_value_1', 'option_name_2', 'option_value_2', 'option_name_3', 'option_value_3',
  'variant_title', 'sku', 'price', 'compare_at_price', 'inventory_quantity', 'image_urls',
] as const;

const CURRENCY_SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
const ANY_SYMBOL = /[£$€]/g;
const MAX_ROWS = 10_000;   // untrusted input — cap the row count
const MAX_CELL = 20_000;   // …and each cell's length (descriptions can be long HTML)

// ── Slug / option helpers ─────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function decimals(pence: number): string {
  return (pence / 100).toFixed(2);
}

/** Ordered option name/value pairs from a variant's stored options JSON. */
function parseOptionPairs(json: string): Array<{ name: string; value: string }> {
  try {
    const obj = JSON.parse(json || '{}') as Record<string, string>;
    return Object.entries(obj).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/** Builds the options object from a row's option_name_i / option_value_i cells. */
function buildOptions(get: (c: string) => string): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const i of [1, 2, 3]) {
    const name = get(`option_name_${i}`);
    const value = get(`option_value_${i}`);
    if (name && value) opts[name] = value;
  }
  return opts;
}

// ── Export ────────────────────────────────────────────────────────────────────

export function buildExportRows(): string[][] {
  const products = query<{ id: string; title: string; slug: string; description: string | null; vendor: string | null; tags_text: string; published: number }>(
    'SELECT id, title, slug, description, vendor, tags_text, published FROM products ORDER BY created_at, title',
  );
  const variants = query<{ product_id: string; title: string; sku: string | null; price: number; compare_at_price: number | null; inventory_quantity: number; options: string }>(
    'SELECT product_id, title, sku, price, compare_at_price, inventory_quantity, options FROM product_variants ORDER BY product_id, position',
  );
  const images = query<{ product_id: string; original: string }>(
    'SELECT product_id, original FROM product_images ORDER BY product_id, position',
  );

  const variantsByProduct = new Map<string, typeof variants>();
  for (const v of variants) (variantsByProduct.get(v.product_id) ?? variantsByProduct.set(v.product_id, []).get(v.product_id)!).push(v);
  const imagesByProduct = new Map<string, string[]>();
  for (const im of images) (imagesByProduct.get(im.product_id) ?? imagesByProduct.set(im.product_id, []).get(im.product_id)!).push(im.original);

  const rows: string[][] = [[...COLUMNS]];
  for (const p of products) {
    const vs = variantsByProduct.get(p.id) ?? [{ product_id: p.id, title: 'Default', sku: null, price: 0, compare_at_price: null, inventory_quantity: 0, options: '{}' }];
    const imgs = imagesByProduct.get(p.id) ?? [];
    vs.forEach((v, idx) => {
      const o = parseOptionPairs(v.options);
      rows.push([
        p.slug, p.title, p.description ?? '', p.vendor ?? '', p.tags_text ?? '', p.published ? 'true' : 'false',
        o[0]?.name ?? '', o[0]?.value ?? '', o[1]?.name ?? '', o[1]?.value ?? '', o[2]?.name ?? '', o[2]?.value ?? '',
        v.title ?? '', v.sku ?? '', decimals(v.price), v.compare_at_price == null ? '' : decimals(v.compare_at_price),
        String(v.inventory_quantity),
        idx === 0 ? imgs.join(', ') : '', // images on the first variant row only
      ]);
    });
  }
  return rows;
}

// ── Dry-run analysis ──────────────────────────────────────────────────────────

export interface RowProblem { row: number; column: string; message: string }
export interface DryRunReport {
  ok: boolean;
  fileError?: string;
  totalRows: number;
  createProducts: number;
  updateProducts: number;
  problemRows: number;
  problems: RowProblem[]; // capped for display
}

interface NormRow { rowNum: number; get: (c: string) => string; handleSlug: string; sku: string; problems: RowProblem[] }

function parsePrice(raw: string, symbol: string): { pence?: number; error?: string } {
  const cleaned = raw.replace(new RegExp(`\\${symbol}`, 'g'), '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { error: `not a valid price ("${raw}") — use a number like 19.99` };
  return { pence: Math.round(parseFloat(cleaned) * 100) };
}

/**
 * Parses + validates the whole file without writing. Returns the report the
 * merchant confirms against, plus the normalised rows the writer reuses.
 */
export function analyze(text: string, storeCurrency: string): { report: DryRunReport; rows: NormRow[] } {
  const symbol = CURRENCY_SYMBOLS[storeCurrency] ?? '';
  const fail = (fileError: string): { report: DryRunReport; rows: NormRow[] } =>
    ({ report: { ok: false, fileError, totalRows: 0, createProducts: 0, updateProducts: 0, problemRows: 0, problems: [] }, rows: [] });

  const grid = parseCsv(text);
  if (grid.length === 0) return fail('The file is empty.');
  const header = grid[0].map((h) => h.trim().toLowerCase());
  if (!header.includes('handle')) return fail('The file needs a "handle" column (the product slug).');
  const dataRows = grid.slice(1);
  if (dataRows.length > MAX_ROWS) return fail(`Too many rows (${dataRows.length}). The limit is ${MAX_ROWS} per import.`);

  const idx = (name: string) => header.indexOf(name);
  const cellOf = (cells: string[], name: string) => { const i = idx(name); return i >= 0 ? (cells[i] ?? '').trim() : ''; };

  // Refuse the whole file if a price carries a currency other than the store's —
  // silently importing the bare number would be wrong.
  for (const cells of dataRows) {
    for (const col of ['price', 'compare_at_price']) {
      const foreign = [...cellOf(cells, col).matchAll(ANY_SYMBOL)].map((m) => m[0]).filter((s) => s !== symbol);
      if (foreign.length) return fail(`A ${col} uses ${foreign[0]}, a different currency than the store (${symbol || storeCurrency}). Convert prices to ${storeCurrency} first.`);
    }
  }

  const problems: RowProblem[] = [];
  const rows: NormRow[] = [];
  dataRows.forEach((cells, i) => {
    const lineNum = i + 2; // header is line 1
    const get = (c: string) => cellOf(cells, c);
    const rowProblems: RowProblem[] = [];

    cells.forEach((val, c) => {
      const column = header[c] || `column ${c + 1}`;
      if ((val ?? '').length > MAX_CELL) rowProblems.push({ row: lineNum, column, message: 'cell is too long' });
      if (looksLikeFormula(val ?? '')) rowProblems.push({ row: lineNum, column, message: 'looks like a formula (possible CSV injection) — remove the leading = + - @' });
    });

    for (const col of ['price', 'compare_at_price'] as const) {
      const raw = get(col);
      if (raw !== '') { const p = parsePrice(raw, symbol); if (p.error) rowProblems.push({ row: lineNum, column: col, message: p.error }); }
    }
    const qty = get('inventory_quantity');
    if (qty !== '' && !/^\d+$/.test(qty)) rowProblems.push({ row: lineNum, column: 'inventory_quantity', message: 'must be a whole number' });

    const handleSlug = slugify(get('handle'));
    const sku = get('sku');
    if (!handleSlug && !sku) rowProblems.push({ row: lineNum, column: 'handle', message: 'a handle or SKU is required' });

    rows.push({ rowNum: lineNum, get, handleSlug, sku, problems: rowProblems });
    problems.push(...rowProblems);
  });

  // Resolve create / real-update / no-op per clean row (read-only). A row that
  // matches an existing product but changes nothing counts as neither — so
  // re-importing an unedited export reports zero creates and zero updates.
  const newHandles = new Set<string>();
  const updatedProducts = new Set<string>();
  for (const r of rows) {
    if (r.problems.length) continue;
    const plan = planRow(r, symbol);
    if (plan.kind === 'create') newHandles.add(r.handleSlug);
    else if (plan.kind === 'update' && plan.productId) updatedProducts.add(plan.productId);
  }

  const report: DryRunReport = {
    ok: true,
    totalRows: dataRows.length,
    createProducts: newHandles.size,
    updateProducts: updatedProducts.size,
    problemRows: rows.filter((r) => r.problems.length > 0).length,
    problems: problems.slice(0, 200),
  };
  return { report, rows };
}

interface CurrentProduct { id: string; title: string; description: string | null; vendor: string | null; tags_text: string; published: number }
interface CurrentVariant { id: string; title: string; price: number; compare_at_price: number | null; inventory_quantity: number }

/** A non-blank cell that differs from the current value → a real change. */
function textChanges(cell: string, current: string | null): boolean {
  return cell !== '' && cell !== (current ?? '');
}
function boolChanges(cell: string, current: number): boolean {
  if (cell === '') return false;
  const b = parseBool(cell);
  return b !== null && b !== current;
}
function priceChanges(cell: string, symbol: string, current: number | null): boolean {
  if (cell === '') return false;
  const p = parsePrice(cell, symbol);
  return p.pence !== undefined && p.pence !== (current ?? null);
}
function qtyChanges(cell: string, current: number): boolean {
  return cell !== '' && /^\d+$/.test(cell) && parseInt(cell, 10) !== current;
}

/** Read-only plan for one clean row: would it create a product, really change an existing one, or nothing? */
function planRow(r: NormRow, symbol: string): { kind: 'create' | 'update' | 'noop'; productId?: string } {
  const get = r.get;
  let product: CurrentProduct | null = null;
  let variant: CurrentVariant | null = null;

  const bySku = r.sku ? queryOne<CurrentVariant & { product_id: string }>('SELECT id, product_id, title, price, compare_at_price, inventory_quantity FROM product_variants WHERE sku = ?', [r.sku]) : null;
  if (bySku) {
    variant = bySku;
    product = queryOne<CurrentProduct>('SELECT id, title, description, vendor, tags_text, published FROM products WHERE id = ?', [bySku.product_id]);
  } else {
    product = queryOne<CurrentProduct>('SELECT id, title, description, vendor, tags_text, published FROM products WHERE slug = ?', [r.handleSlug]);
    if (!product) return { kind: 'create' };
    const options = JSON.stringify(buildOptions(get));
    const vTitle = get('variant_title') || Object.values(buildOptions(get)).join(' / ') || 'Default';
    variant = queryOne<CurrentVariant>('SELECT id, title, price, compare_at_price, inventory_quantity FROM product_variants WHERE product_id = ? AND (options = ? OR title = ?)', [product.id, options, vTitle]);
    if (!variant) return { kind: 'update', productId: product.id }; // adds a new variant
  }

  const changed =
    textChanges(get('title'), product?.title ?? '') ||
    textChanges(get('description'), product?.description ?? null) ||
    textChanges(get('vendor'), product?.vendor ?? null) ||
    textChanges(get('tags'), product?.tags_text ?? '') ||
    boolChanges(get('published'), product?.published ?? 1) ||
    priceChanges(get('price'), symbol, variant?.price ?? null) ||
    priceChanges(get('compare_at_price'), symbol, variant?.compare_at_price ?? null) ||
    qtyChanges(get('inventory_quantity'), variant?.inventory_quantity ?? 0) ||
    textChanges(get('variant_title'), variant?.title ?? '');

  return { kind: changed ? 'update' : 'noop', productId: product?.id };
}

// ── Apply (background writer) ─────────────────────────────────────────────────

const PRODUCT_FIELDS: Record<string, string> = { title: 'title', description: 'description', vendor: 'vendor', tags: 'tags_text' };

function parseBool(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'published', 'active'].includes(s)) return 1;
  if (['0', 'false', 'no', 'draft', 'hidden'].includes(s)) return 0;
  return null;
}

/** UPDATE only the named columns (fixed allowlist keys — no SQL injection). */
function updateColumns(table: 'products' | 'product_variants', id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  execute(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    [...keys.map((k) => fields[k]), id]);
}

export async function applyImport(text: string, storeCurrency: string, jobId: string): Promise<void> {
  const symbol = CURRENCY_SYMBOLS[storeCurrency] ?? '';
  const { rows } = analyze(text, storeCurrency);
  const valid = rows.filter((r) => r.problems.length === 0);
  updateImportJobProgress(jobId, 'Importing products…', valid.length, 0);

  const createdByHandle = new Map<string, string>();
  let processed = 0;

  for (const r of valid) {
    try {
      await applyRow(r, symbol, createdByHandle);
    } catch (err) {
      appendImportJobError(jobId, r.get('handle') || `row ${r.rowNum}`, err instanceof Error ? err.message : String(err));
    }
    processed++;
    if (processed % 20 === 0 || processed === valid.length) updateImportJobProgress(jobId, 'Importing products…', valid.length, processed);
  }

  finishImportJob(jobId, 'completed', `Imported ${valid.length} row(s) — ${createdByHandle.size} new product(s).`);
}

async function applyRow(r: NormRow, symbol: string, createdByHandle: Map<string, string>): Promise<void> {
  const get = r.get;

  // Product-level fields, only where the cell is non-blank ("blank = unchanged").
  const productFields: Record<string, unknown> = {};
  for (const [col, dbCol] of Object.entries(PRODUCT_FIELDS)) {
    const v = get(col);
    if (v !== '') productFields[dbCol] = v;
  }
  const publishedCell = get('published');
  if (publishedCell !== '') { const b = parseBool(publishedCell); if (b !== null) productFields.published = b; }

  // Variant-level fields, likewise.
  const variantFields: Record<string, unknown> = {};
  const priceRaw = get('price'); if (priceRaw !== '') variantFields.price = parsePrice(priceRaw, symbol).pence ?? 0;
  const cmpRaw = get('compare_at_price'); if (cmpRaw !== '') variantFields.compare_at_price = parsePrice(cmpRaw, symbol).pence ?? null;
  const qtyRaw = get('inventory_quantity'); if (qtyRaw !== '') variantFields.inventory_quantity = parseInt(qtyRaw, 10);
  const vTitleCell = get('variant_title'); if (vTitleCell !== '') variantFields.title = vTitleCell;

  // 1. Match a variant by SKU first (globally).
  const bySku = r.sku ? queryOne<{ id: string; product_id: string }>('SELECT id, product_id FROM product_variants WHERE sku = ?', [r.sku]) : null;

  let productId: string;
  let createdProduct = false;
  if (bySku) {
    productId = bySku.product_id;
  } else {
    // 2. Then by handle — an existing product, one created earlier this run, or new.
    productId = createdByHandle.get(r.handleSlug)
      ?? queryOne<{ id: string }>('SELECT id FROM products WHERE slug = ?', [r.handleSlug])?.id
      ?? '';
    if (!productId) {
      const title = get('title') || r.handleSlug;
      productId = randomUUID();
      transaction(() => {
        execute(
          'INSERT INTO products (id, title, slug, description, vendor, tags_text, published) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [productId, title, r.handleSlug, get('description') || null, get('vendor') || null, get('tags') || '',
           publishedCell !== '' ? (parseBool(publishedCell) ?? 1) : 1],
        );
      });
      createdByHandle.set(r.handleSlug, productId);
      createdProduct = true;
    }
  }

  // Apply product-field updates to an existing product (a freshly created one is already set).
  if (!createdProduct) updateColumns('products', productId, productFields);

  // Match / create the variant.
  if (bySku) {
    updateColumns('product_variants', bySku.id, variantFields);
  } else {
    const options = buildOptions(get);
    const optionsJson = JSON.stringify(options);
    const variantTitle = get('variant_title') || Object.values(options).join(' / ') || 'Default';
    const existingVariant = createdProduct ? null
      : queryOne<{ id: string }>('SELECT id FROM product_variants WHERE product_id = ? AND (options = ? OR title = ?)', [productId, optionsJson, variantTitle]);
    if (existingVariant) {
      updateColumns('product_variants', existingVariant.id, variantFields);
    } else {
      execute(
        `INSERT INTO product_variants (id, product_id, title, price, compare_at_price, sku, inventory_quantity, options, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM product_variants WHERE product_id = ?), 0))`,
        [randomUUID(), productId, variantTitle,
         (variantFields.price as number | undefined) ?? 0,
         (variantFields.compare_at_price as number | null | undefined) ?? null,
         r.sku || null,
         (variantFields.inventory_quantity as number | undefined) ?? 0,
         optionsJson, productId],
      );
    }
  }

  // Images: only for a newly created product, from image_urls. The guarded
  // fetcher validates each URL; non-http(s) (e.g. a re-exported local path) is
  // skipped, and importRemoteImage caches by URL so a repeat isn't re-downloaded.
  if (createdProduct) {
    const urls = get('image_urls').split(',').map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
    let pos = 0;
    for (const url of urls) {
      try {
        const img = await importRemoteImage(url);
        execute(
          'INSERT INTO product_images (id, product_id, original, thumbnail, medium, large, alt, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [randomUUID(), productId, img.original, img.thumbnail, img.medium, img.large, '', pos++],
        );
      } catch { /* a broken image URL shouldn't fail the whole product */ }
    }
  }
}

// ── Staging + job launcher ────────────────────────────────────────────────────

const STAGING_DIR = path.join(path.dirname(config.databasePath), '.product-import');
const STAGING_ID = /^[0-9a-f-]{36}$/i;

export function stageCsv(content: string): string {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  const id = randomUUID();
  fs.writeFileSync(path.join(STAGING_DIR, `${id}.csv`), content, 'utf-8');
  return id;
}

export function readStaged(id: string): string | null {
  if (!STAGING_ID.test(id)) return null;
  try { return fs.readFileSync(path.join(STAGING_DIR, `${id}.csv`), 'utf-8'); } catch { return null; }
}

export function discardStaged(id: string): void {
  if (!STAGING_ID.test(id)) return;
  try { fs.rmSync(path.join(STAGING_DIR, `${id}.csv`)); } catch { /* already gone */ }
}

/** Kicks off the background writer for a staged file. Returns the job id, or null if the staged file is gone. */
export function startProductCsvImport(stagingId: string, storeCurrency: string): string | null {
  const text = readStaged(stagingId);
  if (text == null) return null;
  const jobId = createImportJob('product_csv');
  applyImport(text, storeCurrency, jobId)
    .catch((err) => finishImportJob(jobId, 'failed', err instanceof Error ? err.message : 'Import failed'))
    .finally(() => discardStaged(stagingId));
  return jobId;
}
