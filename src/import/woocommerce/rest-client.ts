import type { NormalizedProduct, NormalizedOrder, NormalizedVariation, NormalizedOrderItem, NormalizedPage } from './types';

export interface WooRestConfig {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

interface WooImage { id: number; src: string; alt: string }
interface WooCategory { id: number; name: string; slug: string }
interface WooAttribute { id: number; name: string; option?: string; options?: string[] }

interface WooProductJson {
  id: number; name: string; slug: string; permalink: string; type: string; status: string;
  description: string; sku: string; price: string; regular_price: string; sale_price: string;
  stock_quantity: number | null; stock_status: string;
  categories: WooCategory[]; images: WooImage[]; attributes: WooAttribute[]; variations: number[];
}

interface WooVariationJson {
  id: number; sku: string; price: string; regular_price: string; sale_price: string;
  stock_quantity: number | null; stock_status: string; image: WooImage | null; attributes: WooAttribute[];
}

interface WooAddress {
  first_name?: string; last_name?: string; address_1?: string; address_2?: string;
  city?: string; state?: string; postcode?: string; country?: string; email?: string; phone?: string;
}

interface WooOrderJson {
  id: number; number: string; status: string; currency: string; date_created: string;
  total: string; discount_total: string; shipping_total: string;
  billing: WooAddress; shipping: WooAddress;
  line_items: Array<{ name: string; sku: string | null; quantity: number; price: number; total: string }>;
}

const STATUS_MAP: Record<string, string> = {
  pending: 'pending', 'on-hold': 'pending',
  processing: 'paid', completed: 'paid',
  refunded: 'refunded',
  cancelled: 'cancelled', failed: 'cancelled', trash: 'cancelled',
};

interface WpPageJson {
  id: number;
  slug: string;
  link: string;          // full permalink — WP core REST calls it `link`
  status: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
}

export class WooRestClient {
  private base: string;
  private wpBase: string;
  private authHeader: string;

  constructor(config: WooRestConfig) {
    const root = config.storeUrl.replace(/\/+$/, '');
    this.base = root + '/wp-json/wc/v3';
    this.wpBase = root + '/wp-json/wp/v2';
    this.authHeader = 'Basic ' + Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
  }

  private async getPage<T>(path: string, page: number, base = this.base): Promise<{ items: T[]; totalPages: number }> {
    const url = `${base}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: this.authHeader } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`WooCommerce API error (${res.status}) at ${path}: ${body || res.statusText}`);
    }
    const items = (await res.json()) as T[];
    const totalPages = parseInt(res.headers.get('x-wp-totalpages') ?? '1', 10) || 1;
    return { items, totalPages };
  }

  /** Fetches basic site info from the public WordPress REST root — no auth needed. */
  async fetchSiteInfo(): Promise<{ name: string | null; url: string | null; description: string | null }> {
    try {
      const root = this.base.replace('/wp-json/wc/v3', '');
      const res = await fetch(`${root}/wp-json/`);
      if (!res.ok) return { name: null, url: null, description: null };
      const data = await res.json() as { name?: string; url?: string; description?: string };
      return {
        name: data.name || null,
        url: data.url || null,
        description: data.description || null,
      };
    } catch {
      return { name: null, url: null, description: null };
    }
  }

  /** Verifies the store URL + credentials work before starting a full import. */
  async testConnection(): Promise<void> {
    await this.getPage('/products', 1);
  }

  /** Cheap count (per_page=1) used to size a progress bar before the real fetch loop starts. */
  async count(path: string, base = this.base): Promise<number> {
    const url = `${base}${path}${path.includes('?') ? '&' : '?'}per_page=1&page=1`;
    const res = await fetch(url, { headers: { Authorization: this.authHeader } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`WooCommerce API error (${res.status}) at ${path}: ${body || res.statusText}`);
    }
    await res.json().catch(() => null);
    return parseInt(res.headers.get('x-wp-total') ?? '0', 10) || 0;
  }

  async *fetchProducts(): AsyncGenerator<NormalizedProduct> {
    let page = 1;
    while (true) {
      const { items, totalPages } = await this.getPage<WooProductJson>('/products', page);
      for (const p of items) {
        yield await this.mapProduct(p);
      }
      if (page >= totalPages) break;
      page++;
    }
  }

  private async mapProduct(p: WooProductJson): Promise<NormalizedProduct> {
    const regular = p.regular_price ? parseFloat(p.regular_price) : null;
    const sale = p.sale_price ? parseFloat(p.sale_price) : null;
    const onSale = sale !== null && regular !== null && sale < regular;
    const price = onSale ? sale : (regular ?? (p.price ? parseFloat(p.price) : null));

    let variations: NormalizedVariation[] = [];
    if (p.type === 'variable' && p.variations.length > 0) {
      const { items } = await this.getPage<WooVariationJson>(`/products/${p.id}/variations`, 1);
      variations = items.map((v) => this.mapVariation(v));
    }

    return {
      wcId: p.id,
      permalink: p.permalink || null,
      title: p.name,
      slug: p.slug,
      description: p.description || '',
      sku: p.sku || null,
      price,
      compareAtPrice: onSale ? regular : null,
      stockQuantity: p.stock_quantity ?? (p.stock_status === 'instock' ? 1 : 0),
      published: p.status === 'publish',
      categories: p.categories.map((c) => ({ wcId: c.id, name: c.name, slug: c.slug })),
      images: p.images.map((i) => ({ url: i.src, alt: i.alt || p.name })),
      variations,
    };
  }

  private mapVariation(v: WooVariationJson): NormalizedVariation {
    const regular = v.regular_price ? parseFloat(v.regular_price) : null;
    const sale = v.sale_price ? parseFloat(v.sale_price) : null;
    const onSale = sale !== null && regular !== null && sale < regular;
    const options: Record<string, string> = {};
    for (const attr of v.attributes) {
      if (attr.option) options[attr.name] = attr.option;
    }
    return {
      wcId: v.id,
      title: Object.values(options).join(' / ') || 'Default',
      price: onSale ? sale : (regular ?? (v.price ? parseFloat(v.price) : null)),
      compareAtPrice: onSale ? regular : null,
      sku: v.sku || null,
      stockQuantity: v.stock_quantity ?? (v.stock_status === 'instock' ? 1 : 0),
      options,
      image: v.image ? { url: v.image.src, alt: v.image.alt || '' } : null,
    };
  }

  async countPages(): Promise<number> {
    try { return await this.count('/pages', this.wpBase); } catch { return 0; }
  }

  async *fetchPages(): AsyncGenerator<NormalizedPage> {
    let page = 1;
    while (true) {
      let result: { items: WpPageJson[]; totalPages: number };
      try {
        result = await this.getPage<WpPageJson>('/pages', page, this.wpBase);
      } catch {
        return; // WP core API may not be accessible with WC keys — skip silently
      }
      for (const p of result.items) {
        yield {
          wcId: p.id,
          permalink: p.link || null,
          title: p.title.rendered,
          slug: p.slug,
          content: p.content.rendered,
          excerpt: p.excerpt.rendered,
          status: p.status === 'publish' ? 'published' : 'draft',
        };
      }
      if (page >= result.totalPages) break;
      page++;
    }
  }

  async *fetchOrders(): AsyncGenerator<NormalizedOrder> {
    let page = 1;
    while (true) {
      const { items, totalPages } = await this.getPage<WooOrderJson>('/orders', page);
      for (const o of items) {
        yield this.mapOrder(o);
      }
      if (page >= totalPages) break;
      page++;
    }
  }

  private mapOrder(o: WooOrderJson): NormalizedOrder {
    const items: NormalizedOrderItem[] = o.line_items.map((li) => ({
      productTitle: li.name,
      variantTitle: 'Default',
      sku: li.sku,
      price: Math.round((li.price ?? 0) * 100),
      quantity: li.quantity,
      lineTotal: Math.round(parseFloat(li.total || '0') * 100),
    }));

    const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);

    return {
      wcId: o.id,
      orderNumber: parseInt(o.number, 10) || o.id,
      email: o.billing.email || '',
      status: STATUS_MAP[o.status] ?? 'pending',
      currency: o.currency,
      subtotal,
      discountAmount: Math.round(parseFloat(o.discount_total || '0') * 100),
      shipping: Math.round(parseFloat(o.shipping_total || '0') * 100),
      total: Math.round(parseFloat(o.total || '0') * 100),
      billingAddress: { ...o.billing },
      shippingAddress: { ...o.shipping },
      createdAt: o.date_created || null,
      items,
    };
  }
}
