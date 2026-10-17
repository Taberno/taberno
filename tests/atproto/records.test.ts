import { describe, it, expect } from 'vitest';
import {
  buildProduct,
  buildStorefront,
  buildVariant,
  isoDatetime,
  plainText,
  recordHash,
  variantKey,
  type ProductInput,
  type VariantInput,
} from '../../src/atproto/records';
import { validateRecord } from '../../src/atproto/validate';
import { encrypt, decrypt } from '../../src/atproto/secrets';
import { isTid, nextTid } from '../../src/atproto/tid';

const product: ProductInput = {
  id: 'p1',
  title: 'Harbour at dusk',
  slug: 'harbour-at-dusk',
  description: '<p>A two-colour <strong>risograph</strong> print.</p><p>A3 &amp; A4.</p>',
  vendor: 'Southsea Press',
  tags_text: 'print riso  harbour',
  is_digital: 0,
  available_from: null,
  available_until: null,
  allow_preorder: 0,
  created_at: '2026-09-01 10:00:00',
  updated_at: '2026-09-02 11:30:00',
};

const variant = (o: Partial<VariantInput> = {}): VariantInput => ({
  id: 'v1',
  title: 'A3',
  price: 2500,
  sku: 'HAD-A3',
  inventory_quantity: 4,
  options: '{"Size":"A3"}',
  position: 0,
  ...o,
});

const URI = 'at://did:plc:x/shop.lgtm.commerce.product/3l2abc';

describe('record builders', () => {
  it('builds a valid product with url, tags and option axes', () => {
    const r = buildProduct(product, [variant(), variant({ id: 'v2', options: '{"Size":"A4"}' })], [], 'https://shop.example.com');
    expect(validateRecord('shop.lgtm.commerce.product', r)).toBeNull();
    expect(r).toMatchObject({
      name: 'Harbour at dusk',
      status: 'active',
      brand: 'Southsea Press',
      description: 'A two-colour risograph print.\nA3 & A4.',
      options: [{ name: 'Size', values: ['A3', 'A4'] }],
      createdAt: '2026-09-01T10:00:00.000Z',
      url: 'https://shop.example.com/products/harbour-at-dusk',
      tags: ['print', 'riso', 'harbour'],
    });
  });

  it('builds a valid variant in minor units, never with a stock count', () => {
    const r = buildVariant(variant(), product, URI, 'gbp');
    expect(validateRecord('shop.lgtm.commerce.variant', r)).toBeNull();
    expect(r).toMatchObject({ product: URI, unitAmount: 2500, currency: 'GBP', kind: 'physical', availability: 'available', sku: 'HAD-A3' });
    expect(JSON.stringify(r)).not.toContain('inventory');
  });

  it('marks out-of-stock variants sold out and closed date windows unavailable', () => {
    expect(buildVariant(variant({ inventory_quantity: 0 }), product, URI, 'GBP').availability).toBe('sold_out');
    const ended = { ...product, available_until: '2026-01-01' };
    expect(buildVariant(variant(), ended, URI, 'GBP', '2026-06-01').availability).toBe('unavailable');
    const preorder = { ...product, available_from: '2027-01-01', allow_preorder: 1 };
    expect(buildVariant(variant(), preorder, URI, 'GBP', '2026-06-01').availability).toBe('available');
  });

  it('marks digital products digital', () => {
    expect(buildVariant(variant(), { ...product, is_digital: 1 }, URI, 'GBP').kind).toBe('digital');
  });

  it('builds a valid storefront and drops zones with no real country codes', () => {
    const r = buildStorefront({
      did: 'did:plc:x',
      name: 'Southsea Prints',
      tagline: 'Riso from the coast',
      currency: 'gbp',
      url: 'https://shop.example.com',
      zones: [
        { id: 'z1', name: 'United Kingdom', countries: ['gb'] },
        { id: 'z2', name: 'Everywhere', countries: ['*'] },
      ],
      logo: null,
    });
    expect(validateRecord('shop.lgtm.commerce.storefront', r)).toBeNull();
    expect(r.shippingZones).toEqual([{ code: 'UNITED-KINGDOM', label: 'United Kingdom', countries: ['GB'] }]);
    expect(r.currencies).toEqual(['GBP']);
  });

  it('keys variants by SKU, then options, so re-imported variants keep their record', () => {
    expect(variantKey('p1', variant({ id: 'new-id' }))).toBe(variantKey('p1', variant()));
    const a = variantKey('p1', variant({ sku: null, options: '{"Size":"A3","Colour":"Blue"}' }));
    const b = variantKey('p1', variant({ sku: null, id: 'other', options: '{"Colour":"Blue","Size":"A3"}' }));
    expect(a).toBe(b);
    expect(variantKey('p1', variant({ sku: null, options: '{}', title: 'Default' }))).toBe('variant:p1:title:Default');
  });

  it('hashes records independently of key order', () => {
    expect(recordHash({ a: 1, b: { c: 2, d: 3 } })).toBe(recordHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(recordHash({ a: 1 })).not.toBe(recordHash({ a: 2 }));
  });

  it('converts SQLite timestamps and strips HTML', () => {
    expect(isoDatetime('2026-09-01 10:00:00')).toBe('2026-09-01T10:00:00.000Z');
    expect(plainText('<p>One</p><p>Two<br>Three</p>')).toBe('One\nTwo\nThree');
    expect(plainText('<p> </p>')).toBeNull();
  });
});

describe('secrets', () => {
  it('round-trips and rejects tampering', () => {
    const enc = encrypt('{"token":"abc"}');
    expect(enc).not.toContain('abc');
    expect(decrypt(enc)).toBe('{"token":"abc"}');
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(decrypt(parts.join('.'))).toBeNull();
    expect(decrypt('garbage')).toBeNull();
  });
});

describe('tid', () => {
  it('produces valid, strictly increasing record keys', () => {
    const a = nextTid();
    const b = nextTid();
    expect(isTid(a)).toBe(true);
    expect(isTid(b)).toBe(true);
    expect(b > a).toBe(true);
  });
});

describe('validation', () => {
  it('rejects records that break the lexicon', () => {
    expect(validateRecord('shop.lgtm.commerce.product', { $type: 'shop.lgtm.commerce.product', name: 'x' })).toMatch(/status/);
    expect(validateRecord('shop.lgtm.commerce.variant', { $type: 'shop.lgtm.commerce.variant', product: URI, kind: 'physical', availability: 'available', pricing: 'fixed', currency: 'GBP', unitAmount: -1 })).toMatch(/unitAmount/);
  });
});
