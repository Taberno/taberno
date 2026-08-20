import { XMLParser } from 'fast-xml-parser';
import type { NormalizedProduct, NormalizedVariation, NormalizedCategory, NormalizedImage, NormalizedPage, NormalizedOrder } from './types';

const ARRAY_TAGS = new Set(['item', 'category', 'wp:postmeta']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

interface WxrItem {
  title?: string;
  link?: string;                 // the object's old permalink (full URL)
  'content:encoded'?: string;
  'wp:post_id'?: string;
  'wp:post_type'?: string;
  'wp:post_name'?: string;
  'wp:status'?: string;
  'wp:post_parent'?: string;
  'wp:attachment_url'?: string;
  category?: Array<{ '#text'?: string; '@_domain'?: string; '@_nicename'?: string } | string>;
  'wp:postmeta'?: Array<{ 'wp:meta_key': string; 'wp:meta_value': string }>;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function meta(item: WxrItem, key: string): string | undefined {
  return item['wp:postmeta']?.find((m) => m['wp:meta_key'] === key)?.['wp:meta_value'];
}

function categoriesOf(item: WxrItem, domain: string): Array<{ name: string; slug: string }> {
  return (item.category ?? [])
    .filter((c): c is { '#text'?: string; '@_domain'?: string; '@_nicename'?: string } => typeof c === 'object')
    .filter((c) => c['@_domain'] === domain)
    .map((c) => ({ name: text(c['#text']) || c['@_nicename'] || '', slug: c['@_nicename'] || '' }))
    .filter((c) => c.slug);
}

function toNumber(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function optionsFromAttributeMeta(item: WxrItem): Record<string, string> {
  const options: Record<string, string> = {};
  for (const m of item['wp:postmeta'] ?? []) {
    if (!m['wp:meta_key'].startsWith('attribute_')) continue;
    const name = m['wp:meta_key']
      .replace(/^attribute_/, '')
      .replace(/^pa_/, '')
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    if (m['wp:meta_value']) options[name] = m['wp:meta_value'];
  }
  return options;
}

export interface SiteInfo {
  name: string | null;
  url: string | null;
  description: string | null;
}

export interface WxrParseResult {
  products: NormalizedProduct[];
  pages: NormalizedPage[];
  orders: NormalizedOrder[];
  warnings: string[];
  siteInfo: SiteInfo;
}

/** Parses a WordPress export (WXR) file, pulling out WooCommerce products, variations, categories and images. */
export function parseWxr(xml: string): WxrParseResult {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel ?? {};
  const items: WxrItem[] = channel?.item ?? [];

  const siteInfo: SiteInfo = {
    name: text(channel.title) || null,
    url: text(channel.link) || null,
    description: text(channel.description) || null,
  };
  const warnings: string[] = [];

  const attachmentUrlById = new Map<string, string>();
  for (const item of items) {
    if (item['wp:post_type'] === 'attachment' && item['wp:post_id'] && item['wp:attachment_url']) {
      attachmentUrlById.set(item['wp:post_id'], item['wp:attachment_url']);
    }
  }

  const variationsByParent = new Map<string, WxrItem[]>();
  for (const item of items) {
    if (item['wp:post_type'] === 'product_variation' && item['wp:post_parent']) {
      const list = variationsByParent.get(item['wp:post_parent']) ?? [];
      list.push(item);
      variationsByParent.set(item['wp:post_parent'], list);
    }
  }

  const pages: NormalizedPage[] = [];

  for (const item of items) {
    if (item['wp:post_type'] !== 'page') continue;
    const status = item['wp:status'];
    if (status === 'trash') continue;
    const wcId = parseInt(item['wp:post_id'] ?? '', 10);
    if (!wcId) continue;
    pages.push({
      wcId,
      permalink: text(item.link) || null,
      title: text(item.title),
      slug: item['wp:post_name'] || `page-${wcId}`,
      content: item['content:encoded'] ?? '',
      excerpt: text((item as Record<string, unknown>)['excerpt:encoded']),
      status: status === 'publish' ? 'published' : 'draft',
    });
  }

  const products: NormalizedProduct[] = [];

  for (const item of items) {
    if (item['wp:post_type'] !== 'product') continue;
    const status = item['wp:status'];
    if (status === 'trash') continue;

    const wcId = parseInt(item['wp:post_id'] ?? '', 10);
    if (!wcId) continue;

    const regularPrice = toNumber(meta(item, '_regular_price'));
    const salePrice = toNumber(meta(item, '_sale_price'));
    const fallbackPrice = toNumber(meta(item, '_price'));
    const onSale = salePrice !== null && regularPrice !== null && salePrice < regularPrice;

    const images: NormalizedImage[] = [];
    const thumbId = meta(item, '_thumbnail_id');
    if (thumbId && attachmentUrlById.has(thumbId)) {
      images.push({ url: attachmentUrlById.get(thumbId)!, alt: text(item.title) });
    }
    const gallery = meta(item, '_product_image_gallery');
    if (gallery) {
      for (const id of gallery.split(',').map((s) => s.trim()).filter(Boolean)) {
        const url = attachmentUrlById.get(id);
        if (url && !images.some((i) => i.url === url)) images.push({ url, alt: text(item.title) });
      }
    }

    const categories: NormalizedCategory[] = categoriesOf(item, 'product_cat').map((c) => ({
      wcId: null,
      name: c.name,
      slug: c.slug,
    }));

    const variationItems = variationsByParent.get(item['wp:post_id']!) ?? [];
    const variations: NormalizedVariation[] = variationItems.map((v) => {
      const vRegular = toNumber(meta(v, '_regular_price'));
      const vSale = toNumber(meta(v, '_sale_price'));
      const vFallback = toNumber(meta(v, '_price'));
      const vOnSale = vSale !== null && vRegular !== null && vSale < vRegular;
      const options = optionsFromAttributeMeta(v);
      const vThumbId = meta(v, '_thumbnail_id');
      return {
        wcId: parseInt(v['wp:post_id'] ?? '', 10) || null,
        title: Object.values(options).join(' / ') || 'Default',
        price: vOnSale ? vSale : (vRegular ?? vFallback),
        compareAtPrice: vOnSale ? vRegular : null,
        sku: meta(v, '_sku') || null,
        stockQuantity: toNumber(meta(v, '_stock')) ?? (meta(v, '_stock_status') === 'instock' ? 1 : 0),
        options,
        image: vThumbId && attachmentUrlById.has(vThumbId)
          ? { url: attachmentUrlById.get(vThumbId)!, alt: text(item.title) }
          : null,
      };
    });

    products.push({
      wcId,
      permalink: text(item.link) || null,
      title: text(item.title),
      slug: item['wp:post_name'] || `product-${wcId}`,
      description: item['content:encoded'] ?? '',
      sku: meta(item, '_sku') || null,
      price: onSale ? salePrice : (regularPrice ?? fallbackPrice),
      compareAtPrice: onSale ? regularPrice : null,
      stockQuantity: toNumber(meta(item, '_stock')) ?? (meta(item, '_stock_status') === 'instock' ? 1 : 0),
      published: status === 'publish',
      categories,
      images,
      variations,
    });
  }

  const ORDER_STATUS_MAP: Record<string, string> = {
    'wc-pending': 'pending', 'wc-on-hold': 'pending',
    'wc-processing': 'paid', 'wc-completed': 'paid',
    'wc-refunded': 'refunded',
    'wc-cancelled': 'cancelled', 'wc-failed': 'cancelled', 'wc-trash': 'cancelled',
  };

  const orders: NormalizedOrder[] = [];

  for (const item of items) {
    if (item['wp:post_type'] !== 'shop_order') continue;
    const wcId = parseInt(item['wp:post_id'] ?? '', 10);
    if (!wcId) continue;

    const rawStatus = text(item['wp:status']);
    const status = ORDER_STATUS_MAP[rawStatus] ?? 'pending';

    const total = Math.round((toNumber(meta(item, '_order_total')) ?? 0) * 100);
    const discount = Math.round((toNumber(meta(item, '_cart_discount') ?? meta(item, '_discount_total')) ?? 0) * 100);
    const shipping = Math.round((toNumber(meta(item, '_order_shipping')) ?? 0) * 100);
    const subtotal = total - shipping - Math.round((toNumber(meta(item, '_order_tax')) ?? 0) * 100);
    const currency = meta(item, '_order_currency') ?? 'GBP';
    const email = meta(item, '_billing_email') ?? '';

    const billing: Record<string, string> = {};
    const shipping_addr: Record<string, string> = {};
    for (const [mk, bk] of [
      ['_billing_first_name', 'first_name'], ['_billing_last_name', 'last_name'],
      ['_billing_address_1', 'address_1'], ['_billing_address_2', 'address_2'],
      ['_billing_city', 'city'], ['_billing_state', 'state'],
      ['_billing_postcode', 'postcode'], ['_billing_country', 'country'],
      ['_billing_phone', 'phone'], ['_billing_email', 'email'],
    ] as const) {
      const v = meta(item, mk);
      if (v) billing[bk] = v;
    }
    for (const [mk, sk] of [
      ['_shipping_first_name', 'first_name'], ['_shipping_last_name', 'last_name'],
      ['_shipping_address_1', 'address_1'], ['_shipping_address_2', 'address_2'],
      ['_shipping_city', 'city'], ['_shipping_state', 'state'],
      ['_shipping_postcode', 'postcode'], ['_shipping_country', 'country'],
    ] as const) {
      const v = meta(item, mk);
      if (v) shipping_addr[sk] = v;
    }

    const orderNumber = parseInt(text(item.title), 10) || wcId;
    const createdAt = text((item as Record<string, unknown>)['wp:post_date_gmt'] as unknown) || null;

    orders.push({
      wcId,
      orderNumber,
      email,
      status,
      currency,
      subtotal: Math.max(subtotal, 0),
      discountAmount: discount,
      shipping,
      total,
      billingAddress: billing,
      shippingAddress: shipping_addr,
      createdAt,
      items: [],
    });
  }

  if (products.length === 0 && pages.length === 0 && orders.length === 0) {
    warnings.push('No WooCommerce products, orders or pages found in this export file.');
  }

  return { products, pages, orders, warnings, siteInfo };
}
