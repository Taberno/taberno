import { describe, it, expect, beforeEach } from 'vitest';
import { execute } from '../../src/db/connection';
import { renderFragment } from '../../src/admin/render';
import { parseAddress, sellerBlock, symbolFor, shipTo, billTo } from '../../src/admin/order-print';
import { findOrdersForPacking } from '../../src/db/queries/orders';

// A distinctive price so a stray currency value on a packing slip is unmissable.
const order = {
  id: 'o1', order_number: 1042, email: 'jane@example.com', status: 'paid',
  fulfillment: 'unfulfilled', currency: 'GBP',
  subtotal: 2468, discount_amount: 500, discount_code: 'SAVE5', shipping: 450, tax_amount: 403, total: 2418,
  shipping_title: 'Standard', payment_provider: 'stripe', notes: 'Leave with neighbour',
  due_date: null, pickup_address: null, fulfilment_date: null, fulfilment_window: null,
  shipping_address: JSON.stringify({ firstName: 'Jane', lastName: 'Doe', line1: '1 High St', city: 'Townsville', postcode: 'TN1 2AB', country: 'UK' }),
  billing_address: JSON.stringify({ firstName: 'Jane', lastName: 'Doe', line1: '1 High St', city: 'Townsville', postcode: 'TN1 2AB', country: 'UK' }),
  created_at: '2026-02-10 09:00:00',
};
const items = [
  { product_title: 'Blue Widget', variant_title: 'Large', sku: 'BW-L', price: 1234, quantity: 2, line_total: 2468, preorder: 0, preorder_available_from: null },
];
const settings = { store_name: 'Test Shop', business_name: 'Test Shop Ltd', business_address: '9 Mill Lane\nTownsville\nTN2 3CD', tax_number: 'GB123456789', store_email: 'hi@test.shop', tax_label: 'VAT' };

describe('parseAddress', () => {
  it('reads native camelCase blocks', () => {
    const a = parseAddress(JSON.stringify({ firstName: 'Jane', lastName: 'Doe', line1: '1 High St', line2: 'Flat 2', city: 'Townsville', county: 'Countyshire', postcode: 'TN1 2AB', country: 'UK', phone: '0700' }))!;
    expect(a.name).toBe('Jane Doe');
    expect(a.lines).toEqual(['1 High St', 'Flat 2', 'Townsville, Countyshire', 'TN1 2AB', 'UK']);
    expect(a.phone).toBe('0700');
  });

  it('reads imported WooCommerce snake_case blocks', () => {
    const a = parseAddress(JSON.stringify({ first_name: 'Sam', last_name: 'Ng', address_1: '5 Dock Rd', city: 'Portville', state: 'Harbour', postcode: '90210', country: 'US' }))!;
    expect(a.name).toBe('Sam Ng');
    expect(a.lines).toEqual(['5 Dock Rd', 'Portville, Harbour', '90210', 'US']);
  });

  it('returns null for empty or unparseable blocks (sparse Woo imports)', () => {
    expect(parseAddress('{}')).toBeNull();
    expect(parseAddress(null)).toBeNull();
    expect(parseAddress('not json')).toBeNull();
  });

  it('falls back billTo → shipTo when there is no billing block', () => {
    const o = { ...order, billing_address: '{}' };
    expect(billTo(o as never)?.name).toBe('Jane Doe'); // used the shipping block
    expect(shipTo(o as never)?.name).toBe('Jane Doe');
  });
});

describe('sellerBlock', () => {
  it('is complete with a name and address, and reports incomplete otherwise', () => {
    expect(sellerBlock(settings).complete).toBe(true);
    expect(sellerBlock({ store_name: 'S' }).complete).toBe(false); // no address
    expect(sellerBlock({ business_address: 'x' }).complete).toBe(false); // no name
  });
  it('falls back to the store name', () => {
    expect(sellerBlock({ store_name: 'Fallback', business_address: 'x' }).name).toBe('Fallback');
  });
});

describe('packing slip', () => {
  const html = () => renderFragment('orders/packing-slip', { order, items, shipTo: shipTo(order as never), settings });

  it('shows what goes in the box: order number, address, items, notes', () => {
    const out = html();
    expect(out).toContain('Order #1042');
    expect(out).toContain('Jane Doe');
    expect(out).toContain('Blue Widget');
    expect(out).toContain('Leave with neighbour');
    expect(out).toContain('<title>Order #1042 — Packing slip</title>');
  });

  it('contains NO prices anywhere', () => {
    const out = html();
    expect(out).not.toMatch(/[£$€]/);
    expect(out).not.toContain('12.34'); // unit price
    expect(out).not.toContain('24.68'); // line total / subtotal
    expect(out).not.toContain('24.18'); // total
    expect(out).not.toContain('Subtotal');
  });
});

describe('invoice', () => {
  const html = () => renderFragment('orders/invoice', {
    order, items, billTo: billTo(order as never), seller: sellerBlock(settings),
    symbol: symbolFor(order.currency), isInvoice: false, settings,
  });

  it('shows the same totals as the order (subtotal, discount, shipping, total, tax)', () => {
    const out = html();
    expect(out).toContain('£24.68'); // subtotal (and line total)
    expect(out).toContain('£5.00');  // discount
    expect(out).toContain('SAVE5');
    expect(out).toContain('£4.50');  // shipping
    expect(out).toContain('£24.18'); // total
    expect(out).toContain('£4.03');  // tax included
  });

  it('renders unit prices from the FROZEN order-item values, not live product data', () => {
    // The template reads item.price / item.line_total off the order row — there
    // is no product join — so a later price change can't alter a reprint.
    expect(html()).toContain('£12.34');
  });

  it('renders the seller block and title from settings', () => {
    const out = html();
    expect(out).toContain('Test Shop Ltd');
    expect(out).toContain('VAT: GB123456789');
    expect(out).toContain('<title>Order #1042 — Invoice</title>');
  });
});

describe('bulk print run', () => {
  const slips = [order, { ...order, id: 'o2', order_number: 1043 }, { ...order, id: 'o3', order_number: 1044 }]
    .map((o) => ({ order: o, items, shipTo: shipTo(o as never) }));

  it('paginates one order per page (break-after: page)', () => {
    const out = renderFragment('orders/print-run', { slips, count: 3, date: '2026-02-10', fulfillment: 'unfulfilled', capped: false, cap: 200, settings });
    expect((out.match(/class="page"/g) || []).length).toBe(3);
    expect(out).toContain('break-after: page');
    expect(out).toContain('3 unfulfilled orders');
  });

  it('warns when the run is capped', () => {
    const out = renderFragment('orders/print-run', { slips, count: 200, date: '2026-02-10', fulfillment: 'unfulfilled', capped: true, cap: 200, settings });
    expect(out).toContain('Showing the first 200');
  });

  it('handles an empty run', () => {
    const out = renderFragment('orders/print-run', { slips: [], count: 0, date: '2026-02-10', fulfillment: 'unfulfilled', capped: false, cap: 200, settings });
    expect(out).toContain('No unfulfilled orders for 2026-02-10');
  });
});

describe('findOrdersForPacking', () => {
  beforeEach(() => execute('DELETE FROM orders'));

  function insert(num: number, status: string, fulfillment: string, date: string) {
    execute(
      `INSERT INTO orders (id, order_number, email, status, fulfillment, subtotal, discount_amount, shipping, total, currency, shipping_address, billing_address, created_at)
       VALUES (?, ?, 'a@b.test', ?, ?, 0, 0, 0, 0, 'GBP', '{}', '{}', ?)`,
      [`ord-${num}`, num, status, fulfillment, `${date} 09:00:00`],
    );
  }

  it('returns only unfulfilled, non-cancelled orders for the given day, by number', () => {
    insert(1, 'paid', 'unfulfilled', '2026-02-10');
    insert(2, 'cancelled', 'unfulfilled', '2026-02-10'); // excluded — cancelled
    insert(3, 'paid', 'shipped', '2026-02-10');          // excluded — already shipped
    insert(4, 'paid', 'unfulfilled', '2026-02-11');      // excluded — different day
    insert(5, 'pending', 'unfulfilled', '2026-02-10');   // included — invoice/pending still needs packing

    const rows = findOrdersForPacking({ fulfillment: 'unfulfilled', date: '2026-02-10', limit: 200 });
    expect(rows.map((r) => r.order_number)).toEqual([1, 5]);
  });
});
