import type { OrderRow } from '../db/queries/orders';

const CURRENCY_SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

/** The order's currency symbol, or the code itself for anything unmapped. */
export function symbolFor(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

export interface PrintAddress {
  name: string;
  lines: string[];  // non-empty address lines, in print order
  phone: string;
}

/**
 * Parses a stored address JSON block into printable lines, defensively: native
 * checkout writes camelCase (firstName, line1, county…), imported WooCommerce
 * orders write snake_case (first_name, address_1, state…), and either can be
 * sparse. Returns null when there's nothing worth printing.
 */
export function parseAddress(json: string | null): PrintAddress | null {
  let a: Record<string, unknown> = {};
  try { a = (JSON.parse(json || '{}') as Record<string, unknown>) || {}; } catch { return null; }
  const get = (...keys: string[]): string => {
    for (const k of keys) {
      const v = a[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  };

  const name = [get('firstName', 'first_name'), get('lastName', 'last_name')].filter(Boolean).join(' ');
  const cityLine = [get('city'), get('county', 'state', 'region')].filter(Boolean).join(', ');
  const lines = [
    get('line1', 'address_1', 'address1'),
    get('line2', 'address_2', 'address2'),
    cityLine,
    get('postcode', 'postal_code', 'zip'),
    get('country'),
  ].filter(Boolean);
  const phone = get('phone');

  if (!name && lines.length === 0) return null;
  return { name, lines, phone };
}

export interface SellerBlock {
  name: string;
  address: string;   // multi-line free text, rendered with white-space:pre-line
  vat: string;
  email: string;
  url: string;
  complete: boolean; // false → warn in the admin (never on the document)
}

/** The seller/business block for an invoice, from store settings. */
export function sellerBlock(settings: Record<string, string>): SellerBlock {
  const name = settings.business_name || settings.store_name || '';
  const address = settings.business_address || '';
  return {
    name,
    address,
    vat: settings.tax_number || '',
    email: settings.store_email || '',
    url: settings.store_url || '',
    // An invoice isn't usable as a business record without at least the
    // business name and a postal address.
    complete: !!(name && address.trim()),
  };
}

/** Shipping recipient (packing slip) — the address that goes in the box. */
export function shipTo(order: OrderRow): PrintAddress | null {
  return parseAddress(order.shipping_address);
}

/** Billing recipient (invoice) — falls back to the shipping address. */
export function billTo(order: OrderRow): PrintAddress | null {
  return parseAddress(order.billing_address) ?? parseAddress(order.shipping_address);
}
