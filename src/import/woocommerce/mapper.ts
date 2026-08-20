import { execute, queryOne } from '../../db/connection';
import { importRemoteImage } from './image-fetch';
import { recordImportRedirect, permalinkToPath } from '../../db/queries/redirects';
import type { NormalizedProduct, NormalizedCategory, NormalizedOrder, NormalizedPage } from './types';

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function toPence(amount: number | null): number | null {
  return amount === null ? null : Math.round(amount * 100);
}

/** Matches an existing collection by wc_id (API imports) or slug (WXR imports have no term id), else creates it. */
export function upsertCollection(cat: NormalizedCategory): string {
  const byWcId = cat.wcId != null
    ? queryOne<{ id: string }>('SELECT id FROM collections WHERE wc_id = ?', [cat.wcId])
    : null;
  const existing = byWcId ?? queryOne<{ id: string }>('SELECT id FROM collections WHERE slug = ?', [cat.slug]);

  if (existing) {
    execute(
      `UPDATE collections SET title = ?, wc_id = COALESCE(wc_id, ?), updated_at = datetime('now') WHERE id = ?`,
      [cat.name, cat.wcId, existing.id],
    );
    captureCollectionRedirect(cat, existing.id);
    return existing.id;
  }

  const id = crypto.randomUUID();
  let finalSlug = cat.slug;
  try {
    execute('INSERT INTO collections (id, title, slug, wc_id) VALUES (?, ?, ?, ?)', [id, cat.name, cat.slug, cat.wcId]);
  } catch {
    finalSlug = `${cat.slug}-${cat.wcId ?? id.slice(0, 8)}`;
    execute(
      'INSERT INTO collections (id, title, slug, wc_id) VALUES (?, ?, ?, ?)',
      [id, cat.name, finalSlug, cat.wcId],
    );
  }
  captureCollectionRedirect(cat, id, finalSlug);
  return id;
}

/**
 * 301 a category's old WooCommerce URL to its new collection page. Categories
 * carry no `permalink` in the REST/WXR payloads, so we reconstruct the default
 * `/product-category/<slug>` base (the common case). Reads the collection's
 * actual slug when we don't already know it (existing rows).
 */
function captureCollectionRedirect(cat: NormalizedCategory, collectionId: string, knownSlug?: string): void {
  const slug = knownSlug
    ?? queryOne<{ slug: string }>('SELECT slug FROM collections WHERE id = ?', [collectionId])?.slug;
  if (!slug || !cat.slug) return;
  recordImportRedirect(`/product-category/${cat.slug.toLowerCase()}`, `/collections/${slug}`);
}

/** Upserts a product (matched by wc_id), replacing its variants and images wholesale on each run. */
export async function upsertProduct(product: NormalizedProduct): Promise<{ id: string; created: boolean }> {
  const existing = queryOne<{ id: string }>('SELECT id FROM products WHERE wc_id = ?', [product.wcId]);
  const descriptionPlain = stripHtml(product.description);
  let productId: string;
  let finalSlug = product.slug;
  let created = false;

  if (existing) {
    productId = existing.id;
    execute(
      `UPDATE products SET title=?, slug=?, description=?, description_plain=?, published=?, updated_at=datetime('now') WHERE id=?`,
      [product.title, product.slug, product.description, descriptionPlain, product.published ? 1 : 0, productId],
    );
  } else {
    productId = crypto.randomUUID();
    created = true;
    try {
      execute(
        `INSERT INTO products (id, title, slug, description, description_plain, published, wc_id) VALUES (?,?,?,?,?,?,?)`,
        [productId, product.title, product.slug, product.description, descriptionPlain, product.published ? 1 : 0, product.wcId],
      );
    } catch {
      finalSlug = `${product.slug}-wc${product.wcId}`;
      execute(
        `INSERT INTO products (id, title, slug, description, description_plain, published, wc_id) VALUES (?,?,?,?,?,?,?)`,
        [productId, product.title, finalSlug, product.description, descriptionPlain, product.published ? 1 : 0, product.wcId],
      );
    }
  }

  // 301 the old Woo URLs — the product's permalink (path) and its /?p=<id> form —
  // to the new product page, so migrated shops keep their rankings and links.
  const productPath = `/products/${finalSlug}`;
  const fromPath = product.permalink ? permalinkToPath(product.permalink) : null;
  if (fromPath) recordImportRedirect(fromPath, productPath);
  recordImportRedirect(`/?p=${product.wcId}`, productPath);

  execute('DELETE FROM product_variants WHERE product_id = ?', [productId]);
  execute('DELETE FROM product_images WHERE product_id = ?', [productId]);

  const imageIdByUrl = new Map<string, string>();
  let position = 0;

  const insertImage = async (url: string, alt: string): Promise<string | null> => {
    if (imageIdByUrl.has(url)) return imageIdByUrl.get(url)!;
    try {
      const processed = await importRemoteImage(url);
      const imageId = crypto.randomUUID();
      execute(
        `INSERT INTO product_images (id, product_id, original, thumbnail, medium, large, alt, position) VALUES (?,?,?,?,?,?,?,?)`,
        [imageId, productId, processed.original, processed.thumbnail, processed.medium, processed.large, alt, position++],
      );
      imageIdByUrl.set(url, imageId);
      return imageId;
    } catch {
      return null; // A broken/unreachable image shouldn't block the rest of the product
    }
  };

  for (const img of product.images) {
    await insertImage(img.url, img.alt || product.title);
  }

  if (product.variations.length > 0) {
    let vPos = 0;
    for (const v of product.variations) {
      const imageId = v.image ? await insertImage(v.image.url, v.image.alt || product.title) : null;
      execute(
        `INSERT INTO product_variants (id, product_id, title, price, compare_at_price, sku, inventory_quantity, options, image_id, position)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [crypto.randomUUID(), productId, v.title, toPence(v.price) ?? 0, toPence(v.compareAtPrice), v.sku,
         v.stockQuantity, JSON.stringify(v.options), imageId, vPos++],
      );
    }
  } else {
    execute(
      `INSERT INTO product_variants (id, product_id, title, price, compare_at_price, sku, inventory_quantity, options, position)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), productId, 'Default', toPence(product.price) ?? 0, toPence(product.compareAtPrice),
       product.sku, product.stockQuantity, '{}', 0],
    );
  }

  for (const cat of product.categories) {
    const collectionId = upsertCollection(cat);
    execute(
      'INSERT OR IGNORE INTO collection_products (collection_id, product_id, position) VALUES (?, ?, 0)',
      [collectionId, productId],
    );
  }

  return { id: productId, created };
}

// WooCommerce's own system pages are redundant here — the platform provides
// the cart, checkout, account and shop natively — and importing them clutters
// the store and collides with those built-in routes. Skip them on import.
const WOO_SYSTEM_PAGE_SLUGS = new Set([
  'cart', 'basket', 'bag', 'checkout', 'my-account', 'account',
  'shop', 'order-received', 'order-tracking', 'lost-password', 'wishlist',
]);

export function isWooSystemPage(slug: string): boolean {
  return WOO_SYSTEM_PAGE_SLUGS.has(slug.trim().toLowerCase());
}

/** Upserts a page (matched by wc_id). Slug is made unique on conflict by appending the wc_id. */
export function upsertPage(page: NormalizedPage): { id: string; created: boolean; skipped?: boolean } {
  if (isWooSystemPage(page.slug)) return { id: '', created: false, skipped: true };

  const existing = queryOne<{ id: string }>('SELECT id FROM pages WHERE wc_id = ?', [page.wcId]);
  let finalSlug = page.slug;

  if (existing) {
    execute(
      `UPDATE pages SET title=?, slug=?, content=?, excerpt=?, status=?, updated_at=datetime('now') WHERE id=?`,
      [page.title, page.slug, page.content, page.excerpt, page.status, existing.id],
    );
    capturePageRedirect(page, finalSlug);
    return { id: existing.id, created: false };
  }

  const id = crypto.randomUUID();
  try {
    execute(
      `INSERT INTO pages (id, title, slug, content, excerpt, status, wc_id) VALUES (?,?,?,?,?,?,?)`,
      [id, page.title, page.slug, page.content, page.excerpt, page.status, page.wcId],
    );
  } catch {
    finalSlug = `${page.slug}-${page.wcId}`;
    execute(
      `INSERT INTO pages (id, title, slug, content, excerpt, status, wc_id) VALUES (?,?,?,?,?,?,?)`,
      [id, page.title, finalSlug, page.content, page.excerpt, page.status, page.wcId],
    );
  }
  capturePageRedirect(page, finalSlug);
  return { id, created: true };
}

/** 301 a page's old permalink (and /?p=<id> form) to its new /<slug> path. */
function capturePageRedirect(page: NormalizedPage, finalSlug: string): void {
  const to = `/${finalSlug}`;
  const fromPath = page.permalink ? permalinkToPath(page.permalink) : null;
  if (fromPath) recordImportRedirect(fromPath, to);
  recordImportRedirect(`/?p=${page.wcId}`, to);
}

function resolveOrderNumber(preferred: number): number {
  const clash = queryOne<{ id: string }>('SELECT id FROM orders WHERE order_number = ?', [preferred]);
  if (!clash) return preferred;
  const max = queryOne<{ m: number }>('SELECT COALESCE(MAX(order_number),0) AS m FROM orders')?.m ?? 0;
  return max + 1;
}

/** Upserts an order (matched by wc_id). Record-only — no payment details are imported (Woo's API doesn't expose them). */
export function upsertOrder(order: NormalizedOrder): { id: string; created: boolean } {
  const existing = queryOne<{ id: string }>('SELECT id FROM orders WHERE wc_id = ?', [order.wcId]);
  let orderId: string;
  let created = false;

  if (existing) {
    orderId = existing.id;
    execute(
      `UPDATE orders SET status=?, subtotal=?, discount_amount=?, shipping=?, total=?, currency=?,
       shipping_address=?, billing_address=?, updated_at=datetime('now') WHERE id=?`,
      [order.status, order.subtotal, order.discountAmount, order.shipping, order.total, order.currency,
       JSON.stringify(order.shippingAddress), JSON.stringify(order.billingAddress), orderId],
    );
    execute('DELETE FROM order_items WHERE order_id = ?', [orderId]);
  } else {
    orderId = crypto.randomUUID();
    created = true;
    execute(
      `INSERT INTO orders (id, order_number, email, status, fulfillment, subtotal, discount_amount, shipping, total,
        currency, shipping_address, billing_address, wc_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [orderId, resolveOrderNumber(order.orderNumber), order.email, order.status, 'unfulfilled', order.subtotal,
       order.discountAmount, order.shipping, order.total, order.currency, JSON.stringify(order.shippingAddress),
       JSON.stringify(order.billingAddress), order.wcId, order.createdAt ?? new Date().toISOString()],
    );
  }

  for (const item of order.items) {
    execute(
      `INSERT INTO order_items (id, order_id, product_title, variant_title, sku, price, quantity, line_total)
       VALUES (?,?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), orderId, item.productTitle, item.variantTitle, item.sku, item.price, item.quantity, item.lineTotal],
    );
  }

  return { id: orderId, created };
}
