/** Normalized shapes both the WXR parser and the REST client map into, so upsert logic is shared. */

export interface NormalizedImage {
  url: string;
  alt: string;
}

export interface NormalizedVariation {
  wcId: number | null;
  title: string;
  price: number | null;        // major units, e.g. 19.99 — converted to pence on upsert
  compareAtPrice: number | null;
  sku: string | null;
  stockQuantity: number;
  options: Record<string, string>;
  image: NormalizedImage | null;
}

export interface NormalizedCategory {
  wcId: number | null;
  name: string;
  slug: string;
}

export interface NormalizedProduct {
  wcId: number;
  title: string;
  slug: string;
  description: string;
  sku: string | null;
  price: number | null;
  compareAtPrice: number | null;
  stockQuantity: number;
  published: boolean;
  categories: NormalizedCategory[];
  images: NormalizedImage[];
  variations: NormalizedVariation[];
}

export interface NormalizedPage {
  wcId: number;
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  status: 'published' | 'draft';
}

export interface NormalizedOrderItem {
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  price: number;               // pence
  quantity: number;
  lineTotal: number;           // pence
}

export interface NormalizedOrder {
  wcId: number;
  orderNumber: number;
  email: string;
  status: string;              // mapped to Taberno's status vocabulary
  currency: string;
  subtotal: number;            // pence
  discountAmount: number;      // pence
  shipping: number;            // pence
  total: number;                // pence
  billingAddress: Record<string, unknown>;
  shippingAddress: Record<string, unknown>;
  createdAt: string | null;
  items: NormalizedOrderItem[];
}
