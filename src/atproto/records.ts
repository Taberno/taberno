import crypto from 'crypto';
import { computeAvailability } from '../commerce/availability';

// Pure builders: Taberno rows in, shop.lgtm.commerce.* records out. No I/O,
// so the mapping is easy to test and to reason about.
//
// Records carry a few fields the lexicons don't declare yet (url, tags,
// website, updatedAt, variant title). atproto records may carry extra fields,
// and directories such as Atmarket read them.

export const NS = 'shop.lgtm.commerce';
export const COLLECTIONS = {
  storefront: `${NS}.storefront`,
  product: `${NS}.product`,
  variant: `${NS}.variant`,
} as const;
export type Collection = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** A blob ref as uploadBlob returns it over JSON. */
export interface BlobRef {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

export interface StoreInput {
  did: string;
  name: string;
  tagline: string | null;
  currency: string;
  url: string;
  zones: { id: string; name: string; countries: string[] }[];
  logo: BlobRef | null;
}

export interface ProductInput {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  vendor: string | null;
  tags_text: string | null;
  is_digital: number;
  available_from: string | null;
  available_until: string | null;
  allow_preorder: number;
  created_at: string;
  updated_at: string;
}

export interface VariantInput {
  id: string;
  title: string;
  price: number;
  sku: string | null;
  inventory_quantity: number;
  options: string | null;
  position: number;
}

export type AtRecord = Record<string, unknown> & { $type: string };

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) to an RFC 3339 datetime. */
export function isoDatetime(sqlite: string): string {
  const s = sqlite.includes('T') ? sqlite : `${sqlite.replace(' ', 'T')}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** Product descriptions are HTML from the editor; records want plain text. */
export function plainText(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

export function parseOptions(json: string | null): [string, string][] {
  if (!json) return [];
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    return Object.entries(obj)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && e[0].length > 0 && e[1].length > 0)
      .map(([k, v]) => [clip(k, 128), clip(v, 128)]);
  } catch {
    return [];
  }
}

/**
 * Identifies a variant across re-imports. The WooCommerce importer deletes and
 * re-creates variants with new ids, so the id would churn every record; the
 * SKU, else the option values, else the title, does not.
 */
export function variantKey(productId: string, v: VariantInput): string {
  const sku = v.sku?.trim();
  if (sku) return `variant:${productId}:sku:${sku}`;
  const opts = parseOptions(v.options).sort(([a], [b]) => a.localeCompare(b));
  if (opts.length) return `variant:${productId}:opt:${JSON.stringify(opts)}`;
  return `variant:${productId}:title:${v.title || 'Default'}`;
}

/** Stable hash of a record, so unchanged records are never rewritten. */
export function recordHash(record: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
        : v;
  return crypto.createHash('sha256').update(JSON.stringify(stable(record))).digest('hex');
}

export function buildStorefront(s: StoreInput): AtRecord {
  const zones = s.zones
    .map((z) => ({
      code: clip(z.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || z.id, 32),
      label: clip(z.name, 128),
      countries: [...new Set(z.countries.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))],
    }))
    .filter((z) => z.countries.length > 0);
  return {
    $type: COLLECTIONS.storefront,
    storeDid: s.did,
    displayName: clip(s.name || 'Shop', 256),
    ...(s.tagline ? { description: clip(s.tagline, 2000) } : {}),
    currencies: [s.currency.toUpperCase()],
    ...(zones.length ? { shippingZones: zones } : {}),
    ...(s.logo ? { branding: { logo: s.logo } } : {}),
    website: s.url,
  };
}

export function buildProduct(p: ProductInput, variants: VariantInput[], images: BlobRef[], storeUrl: string): AtRecord {
  // Option axes, in first-seen order, from the variants' option values.
  const axes = new Map<string, string[]>();
  for (const v of [...variants].sort((a, b) => a.position - b.position)) {
    for (const [name, value] of parseOptions(v.options)) {
      const values = axes.get(name) ?? [];
      if (!values.includes(value)) values.push(value);
      axes.set(name, values);
    }
  }
  const description = plainText(p.description);
  const tags = (p.tags_text ?? '').split(/\s+/).filter(Boolean).slice(0, 50);
  return {
    $type: COLLECTIONS.product,
    name: clip(p.title, 512),
    ...(description ? { description: clip(description, 20000) } : {}),
    status: 'active',
    ...(images.length ? { images } : {}),
    ...(p.vendor ? { brand: clip(p.vendor, 256) } : {}),
    ...(axes.size ? { options: [...axes].map(([name, values]) => ({ name, values })) } : {}),
    createdAt: isoDatetime(p.created_at),
    updatedAt: isoDatetime(p.updated_at),
    url: `${storeUrl}/products/${encodeURIComponent(p.slug)}`,
    ...(tags.length ? { tags } : {}),
  };
}

export function buildVariant(
  v: VariantInput,
  p: ProductInput,
  productUri: string,
  currency: string,
  today?: string,
): AtRecord {
  // Mirrors the storefront: in stock means quantity > 0, and the product's
  // date window can close it entirely. Counts are never published.
  const window = computeAvailability(p.available_from, p.available_until, today, p.allow_preorder === 1);
  const availability = !window.orderable ? 'unavailable' : v.inventory_quantity > 0 ? 'available' : 'sold_out';
  const options = parseOptions(v.options);
  return {
    $type: COLLECTIONS.variant,
    product: productUri,
    ...(v.sku?.trim() ? { sku: clip(v.sku.trim(), 128) } : {}),
    kind: p.is_digital === 1 ? 'digital' : 'physical',
    availability,
    pricing: 'fixed',
    unitAmount: Math.max(0, Math.round(v.price)),
    currency: currency.toUpperCase(),
    ...(options.length ? { optionValues: options.map(([name, value]) => ({ name, value })) } : {}),
    ...(v.title && v.title !== 'Default' ? { title: v.title } : {}),
  };
}
