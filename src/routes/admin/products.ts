import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '../../types';
import { render } from '../../admin/render';
import { getAdminById } from '../../admin/auth';
import { getAllSettings, getSetting } from '../../db/queries/admin';
import { processUploadedImage } from '../../admin/images';
import fs from 'fs';
import path from 'path';
import { execute, query, queryOne } from '../../db/connection';
import { findAllBands } from '../../db/queries/tax';
import { saveProductFile, deleteProductFile, findFileForProduct } from '../../db/queries/downloads';
import { findManualRelatedIds, getProductNamesByIds, setRelatedProducts, searchProductsByTitle } from '../../db/queries/products';
import { productLimitReached } from '../../billing/usage';
import { getLimits } from '../../billing/limits';
import type { MultipartFile } from '@fastify/multipart';
import config from '../../config';
import { buildExportRows, analyze, stageCsv, startProductCsvImport } from '../../import/product-csv/products';
import { serializeCsv } from '../../import/product-csv/csv';
import { findImportJob, listRecentImportJobs } from '../../db/queries/import';

interface ProductRow {
  id: string; title: string; slug: string; description: string | null;
  vendor: string | null; tags_text: string; published: number;
  tax_band_id: string | null; is_digital: number;
  created_at: string; updated_at: string;
}
interface VariantRow {
  id: string; title: string; price: number; compare_at_price: number | null;
  sku: string | null; inventory_quantity: number; position: number;
}
interface ImageRow {
  id: string; original: string; thumbnail: string; medium: string; large: string;
  alt: string; position: number;
}

export async function productRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/products', listProducts);
  // Static paths before /:id so they aren't read as an id.
  fastify.get('/products/search', productSearch);
  fastify.get('/products/export.csv', exportProductsCsv);
  fastify.get('/products/import', productImportPage);
  fastify.post('/products/import', productImportUpload);       // dry run
  fastify.post('/products/import/apply', productImportApply);  // confirmed write
  fastify.get('/products/new', newProductPage);
  fastify.post('/products/new', createProduct);
  fastify.get('/products/:id', editProductPage);
  fastify.post('/products/:id', updateProduct);
  fastify.post('/products/:id/delete', deleteProduct);
  fastify.post('/products/:id/images', uploadImage);
  fastify.post('/products/:id/images/:imageId/delete', deleteImage);
  fastify.post('/products/:id/file', uploadDigitalFile);
  fastify.post('/products/:id/file/delete', deleteDigitalFile);
}

/** Current manual related products (id + title, in order) + a JSON seed for the picker. */
function relatedFormData(productId: string | null): { related: { id: string; title: string }[]; relatedJson: string } {
  if (!productId) return { related: [], relatedJson: '[]' };
  const ids = findManualRelatedIds(productId);
  const names = new Map(getProductNamesByIds(ids).map((r) => [r.id, r.title]));
  const related = ids.map((id) => ({ id, title: names.get(id) ?? '(deleted product)' }));
  return { related, relatedJson: JSON.stringify(related).replace(/</g, '\\u003c') };
}

async function productSearch(req: FastifyRequest<{ Querystring: { q?: string } }>, reply: FastifyReply) {
  const q = (req.query.q ?? '').trim();
  return reply.send(q.length < 2 ? [] : searchProductsByTitle(q, 10));
}

function adminCtx(req: FastifyRequest) {
  return {
    admin: getAdminById(req.session.adminId!)!,
    settings: getAllSettings(),
  };
}

// ── CSV export / import ───────────────────────────────────────────────────────

async function exportProductsCsv(_req: FastifyRequest, reply: FastifyReply) {
  const csv = serializeCsv(buildExportRows()); // one row per variant; BOM included
  const today = new Date().toISOString().slice(0, 10);
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="products-${today}.csv"`)
    .send(csv);
}

async function productImportPage(
  req: FastifyRequest<{ Querystring: { job?: string; error?: string } }>,
  reply: FastifyReply,
) {
  const activeJob = req.query.job ? findImportJob(req.query.job) : null;
  return reply.type('text/html').send(
    await render('products/import', {
      ...adminCtx(req),
      activeJob,
      jobs: listRecentImportJobs(20).filter((j) => j.source === 'product_csv').slice(0, 8),
      error: req.query.error,
      pageTitle: 'Import products',
      pageSection: 'products',
    }, reply),
  );
}

/** Phase 1: parse + validate, write nothing, show the report for confirmation. */
async function productImportUpload(req: FastifyRequest, reply: FastifyReply) {
  const data = await req.file();
  if (!data) return reply.redirect('/admin/products/import?error=no_file');
  const buf = await data.toBuffer();

  const renderImport = (extra: Record<string, unknown>) =>
    reply.type('text/html').send(render('products/import', {
      ...adminCtx(req), pageTitle: 'Import products', pageSection: 'products', ...extra,
    }, reply));

  if (buf.length > 15 * 1024 * 1024) {
    return renderImport({ report: { ok: false, fileError: 'File too large (15MB max).' } });
  }

  const currency = getSetting('store_currency') || 'GBP';
  const { report } = analyze(buf.toString('utf-8'), currency);
  if (!report.ok) return renderImport({ report });

  // Stage the file so phase 2 can write it after the merchant confirms.
  const stagingId = stageCsv(buf.toString('utf-8'));
  return renderImport({ report, stagingId });
}

/** Phase 2: the merchant confirmed — run the background writer over the staged file. */
async function productImportApply(
  req: FastifyRequest<{ Body: { staging_id?: string } }>,
  reply: FastifyReply,
) {
  const currency = getSetting('store_currency') || 'GBP';
  const jobId = startProductCsvImport(req.body.staging_id ?? '', currency);
  if (!jobId) return reply.redirect('/admin/products/import?error=expired');
  return reply.redirect(`/admin/products/import?job=${jobId}`);
}

async function listProducts(req: FastifyRequest<{ Querystring: { page?: string } }>, reply: FastifyReply) {
  const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
  const limit = 25;
  const offset = (page - 1) * limit;
  const products = query<ProductRow>(
    'SELECT * FROM products ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset],
  );
  const total = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM products')?.n ?? 0;
  return reply.type('text/html').send(
    await render('products/list', {
      ...adminCtx(req), products, total,
      page, totalPages: Math.ceil(total / limit),
      pageTitle: 'Products',
    }, reply),
  );
}

async function newProductPage(req: FastifyRequest, reply: FastifyReply) {
  return reply.type('text/html').send(
    await render('products/form', { ...adminCtx(req), product: null, variants: [], images: [], taxBands: findAllBands(), ...relatedFormData(null), pageTitle: 'New product' }, reply),
  );
}

async function editProductPage(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const product = queryOne<ProductRow>('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) return reply.code(404).type('text/html').send(await render('404', { pageTitle: 'Not found' }, reply));
  const variants = query<VariantRow>('SELECT * FROM product_variants WHERE product_id = ? ORDER BY position', [product.id]);
  const images = query<ImageRow>('SELECT * FROM product_images WHERE product_id = ? ORDER BY position', [product.id]);
  const digitalFile = findFileForProduct(product.id);
  const query_ = req.query as Record<string, string>;
  return reply.type('text/html').send(
    await render('products/form', {
      ...adminCtx(req), product, variants, images, taxBands: findAllBands(),
      ...relatedFormData(product.id),
      digitalFile, pageTitle: product.title,
      saved: query_.saved === '1', created: query_.created === '1',
      uploaded: query_.uploaded === '1',
    }, reply),
  );
}

async function createProduct(
  req: FastifyRequest<{ Body: Record<string, string> }>,
  reply: FastifyReply,
) {
  const { title, slug, description, vendor, tags_text, published,
          variant_title, price, compare_at_price, sku, inventory_quantity,
          seo_title, seo_description, free_shipping, is_digital } = req.body;

  if (!title || !slug) {
    return reply.type('text/html').send(
      await render('products/form', { ...adminCtx(req), product: req.body, variants: [], images: [],
        taxBands: findAllBands(), error: 'Title and slug are required', pageTitle: 'New product' }, reply),
    );
  }

  // Quota: block new products once the injected product limit is reached (admin
  // side only — never the storefront). Existing products keep working. Limits
  // are set by the host; a standalone install has none, so this never fires.
  if (productLimitReached()) {
    const upgradeUrl = getSetting('upgrade_url');
    return reply.type('text/html').send(
      await render('products/form', { ...adminCtx(req), product: req.body, variants: [], images: [],
        taxBands: findAllBands(), pageTitle: 'New product',
        error: `You've reached this store's product limit of ${getLimits().products}.` +
          (upgradeUrl ? ` Visit ${upgradeUrl} to raise it.` : '') }, reply),
    );
  }

  const productId = crypto.randomUUID();
  const variantId = crypto.randomUUID();
  const priceInt = Math.round(parseFloat(price || '0') * 100);
  const compareInt = compare_at_price ? Math.round(parseFloat(compare_at_price) * 100) : null;
  const qty = parseInt(inventory_quantity || '0', 10);

  const tax_band_id = req.body.tax_band_id?.trim() || null;
  const requires_slot = req.body.requires_slot === '1' ? 1 : 0;
  const available_from = req.body.available_from?.trim() || null;
  const available_until = req.body.available_until?.trim() || null;
  const allow_preorder = req.body.allow_preorder === '1' ? 1 : 0;
  execute(
    `INSERT INTO products (id, title, slug, description, vendor, tags_text, published, seo_title, seo_description, free_shipping, is_digital, tax_band_id, available_from, available_until, allow_preorder, requires_slot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [productId, title.trim(), slug.trim(), description || null, vendor || null, tags_text || '', published === '1' ? 1 : 0,
     seo_title || null, seo_description || null, free_shipping === '1' ? 1 : 0,
     is_digital === '1' ? 1 : 0, tax_band_id, available_from, available_until, allow_preorder, requires_slot],
  );
  execute(
    `INSERT INTO product_variants (id, product_id, title, price, compare_at_price, sku, inventory_quantity)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [variantId, productId, variant_title || 'Default', priceInt, compareInt, sku || null, qty],
  );
  setRelatedProducts(productId, (req.body.related_ids ?? '').split(',').filter(Boolean));

  return reply.redirect(`/admin/products/${productId}?created=1`);
}

async function updateProduct(
  req: FastifyRequest<{ Params: { id: string }; Body: Record<string, string> }>,
  reply: FastifyReply,
) {
  const { id } = req.params;
  const product = queryOne<ProductRow>('SELECT id FROM products WHERE id = ?', [id]);
  if (!product) return reply.code(404).send('Not found');

  const { title, slug, description, vendor, tags_text, published, seo_title, seo_description, free_shipping, is_digital: is_digital_update } = req.body;
  const tax_band_id_update = req.body.tax_band_id?.trim() || null;
  const requires_slot = req.body.requires_slot === '1' ? 1 : 0;
  const available_from = req.body.available_from?.trim() || null;
  const available_until = req.body.available_until?.trim() || null;
  const allow_preorder = req.body.allow_preorder === '1' ? 1 : 0;
  execute(
    `UPDATE products SET title=?, slug=?, description=?, vendor=?, tags_text=?, published=?, seo_title=?, seo_description=?, free_shipping=?, is_digital=?, tax_band_id=?, available_from=?, available_until=?, allow_preorder=?, requires_slot=?, updated_at=datetime('now') WHERE id=?`,
    [title, slug, description || null, vendor || null, tags_text || '', published === '1' ? 1 : 0,
     seo_title || null, seo_description || null, free_shipping === '1' ? 1 : 0,
     is_digital_update === '1' ? 1 : 0, tax_band_id_update, available_from, available_until, allow_preorder, requires_slot, id],
  );

  // Update variants if provided
  const variantIds = (req.body.variant_ids ?? '').split(',').filter(Boolean);
  for (const vid of variantIds) {
    const vPrice = Math.round(parseFloat(req.body[`price_${vid}`] || '0') * 100);
    const vCompare = req.body[`compare_at_price_${vid}`]
      ? Math.round(parseFloat(req.body[`compare_at_price_${vid}`]) * 100) : null;
    const vQty = parseInt(req.body[`inventory_quantity_${vid}`] || '0', 10);
    execute(
      `UPDATE product_variants SET title=?, price=?, compare_at_price=?, sku=?, inventory_quantity=?, updated_at=datetime('now') WHERE id=? AND product_id=?`,
      [req.body[`variant_title_${vid}`] || 'Default', vPrice, vCompare, req.body[`sku_${vid}`] || null, vQty, vid, id],
    );
  }

  setRelatedProducts(id, (req.body.related_ids ?? '').split(',').filter(Boolean));

  return reply.redirect(`/admin/products/${id}?saved=1`);
}

async function deleteProduct(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  execute('DELETE FROM products WHERE id = ?', [req.params.id]);
  return reply.redirect('/admin/products?deleted=1');
}

async function uploadImage(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const product = queryOne<{ id: string }>('SELECT id FROM products WHERE id = ?', [req.params.id]);
  if (!product) return reply.code(404).send('Not found');

  const data = await req.file();
  if (!data) return reply.redirect(`/admin/products/${req.params.id}?error=no_file`);

  const buf = await data.toBuffer();
  const processed = await processUploadedImage(buf, data.filename);

  const maxPos = queryOne<{ m: number }>('SELECT COALESCE(MAX(position),0) AS m FROM product_images WHERE product_id = ?', [product.id])?.m ?? 0;
  execute(
    'INSERT INTO product_images (id, product_id, original, thumbnail, medium, large, alt, position) VALUES (?,?,?,?,?,?,?,?)',
    [crypto.randomUUID(), product.id, processed.original, processed.thumbnail, processed.medium, processed.large, '', maxPos + 1],
  );

  return reply.redirect(`/admin/products/${req.params.id}?uploaded=1`);
}

async function deleteImage(
  req: FastifyRequest<{ Params: { id: string; imageId: string } }>,
  reply: FastifyReply,
) {
  execute('DELETE FROM product_images WHERE id = ? AND product_id = ?', [req.params.imageId, req.params.id]);
  return reply.redirect(`/admin/products/${req.params.id}`);
}

async function uploadDigitalFile(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const product = queryOne<{ id: string }>('SELECT id FROM products WHERE id = ?', [req.params.id]);
  if (!product) return reply.code(404).send('Not found');

  const data = await req.file();
  if (!data) return reply.redirect(`/admin/products/${req.params.id}?error=no_file`);

  const buf = await data.toBuffer();
  const ext = path.extname(data.filename) || '';
  const filename = `${crypto.randomUUID()}${ext}`;
  const dir = config.digitalFilesDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), buf);

  // Delete old file from disk if any
  const existing = findFileForProduct(product.id);
  if (existing) {
    try { fs.unlinkSync(path.join(dir, existing.filename)); } catch { /* already gone */ }
  }

  saveProductFile(product.id, filename, data.filename, data.mimetype || null, buf.length);
  return reply.redirect(`/admin/products/${req.params.id}?saved=1`);
}

async function deleteDigitalFile(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const existing = findFileForProduct(req.params.id);
  if (existing) {
    try { fs.unlinkSync(path.join(config.digitalFilesDir, existing.filename)); } catch { /* already gone */ }
    deleteProductFile(req.params.id);
  }
  return reply.redirect(`/admin/products/${req.params.id}`);
}
