import { randomUUID } from 'crypto';
import { query, queryOne, execute, executeReturning, transaction, db } from '../connection';
import { getProductAvailabilityByVariant } from './products';
import { computeAvailability } from '../../commerce/availability';

export interface OrderRow {
  id: string;
  order_number: number;
  email: string;
  status: string;
  fulfillment: string;
  subtotal: number;
  discount_amount: number;
  shipping: number;
  total: number;
  currency: string;
  discount_code: string | null;
  notes: string | null;
  shipping_address: string;
  billing_address: string;
  payment_provider: string | null;
  payment_reference: string | null;
  shipping_rate_id: string | null;
  shipping_title: string | null;
  tax_amount: number;
  pickup_address: string | null;
  pickup_instructions: string | null;
  fulfilment_date: string | null;   // YYYY-MM-DD booked slot date
  fulfilment_window: string | null; // booked time-window label
  due_date: string | null;          // YYYY-MM-DD invoice due date (pay-on-account)
  accounting_ref: string | null;    // external accounting/invoice id (reserved for a future sync)
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  reminder_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export const ORDER_STATUSES = ['pending', 'paid', 'cancelled', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const FULFILLMENT_STATES = ['unfulfilled', 'shipped', 'delivered'] as const;
export type FulfillmentState = (typeof FULFILLMENT_STATES)[number];

export interface OrderItemRow {
  id: string;
  order_id: string;
  variant_id: string | null;
  product_title: string;
  variant_title: string;
  sku: string | null;
  price: number;
  quantity: number;
  line_total: number;
  preorder: number;                      // 1 | 0
  preorder_available_from: string | null; // YYYY-MM-DD the item ships from
}

export interface Address {
  firstName: string;
  lastName: string;
  line1: string;
  line2?: string;
  city: string;
  county?: string;
  postcode: string;
  country: string;
  phone?: string;
}

export interface CreateOrderInput {
  email: string;
  subtotal: number;
  discountAmount: number;
  shipping: number;
  total: number;
  currency: string;
  discountCode: string | null;
  notes: string | null;
  shippingAddress: Address;
  paymentProvider: string;
  paymentReference: string | null;
  shippingRateId?: string | null;
  shippingTitle?: string | null;
  taxAmount?: number;
  pickupAddress?: string | null;
  pickupInstructions?: string | null;
  fulfilmentDate?: string | null;
  fulfilmentWindow?: string | null;
  dueDate?: string | null;
  items: Array<{
    variantId: string | null;
    productTitle: string;
    variantTitle: string;
    sku: string | null;
    price: number;
    quantity: number;
  }>;
}

export function findOrders(limit = 50, offset = 0): OrderRow[] {
  return query<OrderRow>(
    'SELECT * FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset],
  );
}

export function countOrders(): number {
  return queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM orders')?.n ?? 0;
}

/** All orders, newest first — for the admin CSV export (not paginated). */
export function findAllOrders(): OrderRow[] {
  return query<OrderRow>('SELECT * FROM orders ORDER BY created_at DESC');
}

/**
 * Orders for the bulk packing-slip print run: by fulfillment state and,
 * optionally, a single day (matched on the UTC calendar date of created_at).
 * Cancelled/refunded orders are never packed, so they're excluded. Ordered by
 * order number so the printed stack is in a predictable sequence. `limit` is
 * the caller's cap — pass cap+1 to detect an over-cap run.
 */
export function findOrdersForPacking(opts: { fulfillment: string; date?: string; limit: number }): OrderRow[] {
  const clauses = ["status NOT IN ('cancelled','refunded')", 'fulfillment = ?'];
  const params: unknown[] = [opts.fulfillment];
  if (opts.date) { clauses.push('date(created_at) = ?'); params.push(opts.date); }
  params.push(opts.limit);
  return query<OrderRow>(
    `SELECT * FROM orders WHERE ${clauses.join(' AND ')} ORDER BY order_number ASC LIMIT ?`,
    params,
  );
}

export interface OrderStockLevel {
  product_title: string;
  variant_title: string;
  sku: string | null;
  remaining: number;  // current inventory (after this order's decrement)
  ordered: number;    // quantity in this order
}

/**
 * Pending orders ripe for an abandoned-checkout reminder: older than `delayHours`
 * but newer than `maxAgeDays`, never reminded, with an email, where that email has
 * no completed order and hasn't opted out. One row per email (the newest pending).
 */
export function findAbandonedOrders(delayHours: number, maxAgeDays: number): OrderRow[] {
  return query<OrderRow>(
    `SELECT o.* FROM orders o
      WHERE o.status = 'pending'
        AND o.reminder_sent_at IS NULL
        AND o.email <> ''
        AND o.created_at <= datetime('now', ?)
        AND o.created_at >= datetime('now', ?)
        AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.email = o.email AND p.status = 'paid')
        AND o.email NOT IN (SELECT email FROM email_suppressions)
        AND o.id = (SELECT id FROM orders o2 WHERE o2.email = o.email AND o2.status = 'pending'
                     ORDER BY o2.created_at DESC LIMIT 1)
      ORDER BY o.created_at DESC`,
    [`-${delayHours} hours`, `-${maxAgeDays} days`],
  );
}

/** Flags every pending order for this email as reminded, so siblings don't re-trigger. */
export function markAbandonedReminderSent(email: string): void {
  execute(
    "UPDATE orders SET reminder_sent_at = datetime('now') WHERE email = ? AND status = 'pending' AND reminder_sent_at IS NULL",
    [email],
  );
}

/** Current stock for the physical variants in an order — used to detect low-stock crossings. */
export function findOrderStockLevels(orderId: string): OrderStockLevel[] {
  return query<OrderStockLevel>(
    `SELECT oi.product_title, oi.variant_title, oi.sku,
            v.inventory_quantity AS remaining, oi.quantity AS ordered
       FROM order_items oi
       JOIN product_variants v ON v.id = oi.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE oi.order_id = ? AND oi.variant_id IS NOT NULL AND p.is_digital = 0`,
    [orderId],
  );
}

export function findOrderById(id: string): OrderRow | null {
  return queryOne<OrderRow>('SELECT * FROM orders WHERE id = ?', [id]);
}

export function findOrderByPaymentReference(reference: string): OrderRow | null {
  return queryOne<OrderRow>('SELECT * FROM orders WHERE payment_reference = ?', [reference]);
}

export function findOrderItems(orderId: string): OrderItemRow[] {
  return query<OrderItemRow>('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
}

/**
 * Distinct product ids in an order, in line-item order. Used for the marketing
 * purchase pixel's `content_ids` so they match the product feed's `g:id` (also
 * the product id) — required for Meta/Google to attribute a purchase to the
 * right catalogue item for dynamic ads.
 */
export function getOrderProductIds(orderId: string): string[] {
  return query<{ product_id: string }>(
    `SELECT v.product_id
       FROM order_items oi
       JOIN product_variants v ON v.id = oi.variant_id
      WHERE oi.order_id = ? AND oi.variant_id IS NOT NULL
      GROUP BY v.product_id
      ORDER BY MIN(oi.rowid)`,
    [orderId],
  ).map((r) => r.product_id);
}

export function createOrder(input: CreateOrderInput): OrderRow {
  const id = randomUUID();
  const nextNumber = queryOne<{ n: number }>('SELECT COALESCE(MAX(order_number), 1000) + 1 AS n FROM orders')!.n;

  const row = executeReturning<OrderRow>(`
    INSERT INTO orders (
      id, order_number, email, status, fulfillment,
      subtotal, discount_amount, shipping, total, currency,
      discount_code, notes, shipping_address, billing_address,
      payment_provider, payment_reference,
      shipping_rate_id, shipping_title, tax_amount,
      pickup_address, pickup_instructions,
      fulfilment_date, fulfilment_window, due_date
    ) VALUES (?, ?, ?, 'pending', 'unfulfilled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `, [
    id, nextNumber, input.email,
    input.subtotal, input.discountAmount, input.shipping, input.total, input.currency,
    input.discountCode, input.notes,
    JSON.stringify(input.shippingAddress),
    JSON.stringify(input.shippingAddress),
    input.paymentProvider, input.paymentReference,
    input.shippingRateId ?? null, input.shippingTitle ?? null,
    input.taxAmount ?? 0,
    input.pickupAddress ?? null, input.pickupInstructions ?? null,
    input.fulfilmentDate ?? null, input.fulfilmentWindow ?? null,
    input.dueDate ?? null,
  ]);

  for (const item of input.items) {
    // Flag the line as a pre-order (with its ship-from date) if the product is
    // in its upcoming window and allows pre-orders — captured at order time so
    // the merchant still sees it after the window opens.
    let preorder = 0;
    let preorderFrom: string | null = null;
    const win = item.variantId ? getProductAvailabilityByVariant(item.variantId) : null;
    if (win) {
      const a = computeAvailability(win.available_from, win.available_until, undefined, win.allow_preorder === 1);
      if (a.preorder) { preorder = 1; preorderFrom = win.available_from; }
    }
    execute(`
      INSERT INTO order_items (id, order_id, variant_id, product_title, variant_title, sku, price, quantity, line_total, preorder, preorder_available_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [randomUUID(), id, item.variantId, item.productTitle, item.variantTitle, item.sku, item.price, item.quantity, item.price * item.quantity, preorder, preorderFrom]);
  }

  return row;
}

/**
 * Transitions an order to 'paid' and decrements stock for its physical items,
 * atomically. Returns true if this call performed the transition, false if the
 * order was already paid — the guard on `status != 'paid'` makes this
 * idempotent, so the Stripe return handler and webhook (which can both fire
 * for one order) decrement inventory exactly once between them. Digital
 * products (p.is_digital = 1) carry no stock and are skipped; physical stock is
 * floored at 0 so a race that oversells shows 0, never a negative count.
 */
/**
 * Decrements physical stock for an order's items and counts any discount code's
 * redemption. Shared by the paid path (markOrderPaid) and the invoice path
 * (confirmInvoiceOrder) — both represent a committed sale. Must run inside a
 * transaction. Digital products carry no stock and are skipped; physical stock
 * is floored at 0 so a race that oversells shows 0, never a negative count.
 */
function applyOrderStockAndDiscount(orderId: string): void {
  db.prepare(`
    UPDATE product_variants
    SET inventory_quantity = MAX(0, inventory_quantity - (
          SELECT oi.quantity FROM order_items oi
          WHERE oi.variant_id = product_variants.id AND oi.order_id = ?
        )),
        updated_at = datetime('now')
    WHERE id IN (
      SELECT oi.variant_id FROM order_items oi
      JOIN products p ON p.id = (SELECT product_id FROM product_variants WHERE id = oi.variant_id)
      WHERE oi.order_id = ? AND oi.variant_id IS NOT NULL AND p.is_digital = 0
    )
  `).run(orderId, orderId);

  const dc = db.prepare('SELECT discount_code FROM orders WHERE id = ?').get(orderId) as { discount_code: string | null };
  if (dc?.discount_code) {
    db.prepare('UPDATE discounts SET times_used = times_used + 1 WHERE code = ?').run(dc.discount_code);
  }
}

export function markOrderPaid(orderId: string, paymentReference: string): boolean {
  return transaction(() => {
    const res = db.prepare(
      `UPDATE orders SET status = 'paid', payment_reference = ?, updated_at = datetime('now')
       WHERE id = ? AND status != 'paid'`,
    ).run(paymentReference, orderId);
    if (res.changes === 0) return false;

    // Count a discount code's use once the order is actually paid (not on the
    // abandoned pending order), so usage limits reflect real redemptions.
    applyOrderStockAndDiscount(orderId);
    return true;
  });
}

/**
 * Commits a pay-on-account (invoice) order at placement time: it reserves stock
 * and counts discount usage exactly as a paid order would, but leaves the order
 * `pending` (unpaid) — the merchant flips it to `paid` from the admin once the
 * invoice is settled. Idempotent per order via `invoice_committed`, so a
 * double-submit can't decrement stock twice.
 */
export function confirmInvoiceOrder(orderId: string): void {
  transaction(() => {
    const res = db.prepare(
      `UPDATE orders SET invoice_committed = 1, updated_at = datetime('now')
       WHERE id = ? AND COALESCE(invoice_committed, 0) = 0`,
    ).run(orderId);
    if (res.changes === 0) return;
    applyOrderStockAndDiscount(orderId);
  });
}

export function updateOrderStatus(orderId: string, status: OrderStatus): void {
  execute(
    `UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    [status, orderId],
  );
}

/**
 * Records a shipment. `shipped_at` is stamped the first time an order moves to
 * 'shipped' and left untouched otherwise, so re-saving tracking details for an
 * already-shipped order doesn't reset the ship date. Tracking fields are
 * cleared when reverting to 'unfulfilled'.
 */
export function updateOrderFulfillment(
  orderId: string,
  fulfillment: FulfillmentState,
  trackingNumber: string | null,
  trackingUrl: string | null,
): void {
  if (fulfillment === 'unfulfilled') {
    execute(
      `UPDATE orders SET fulfillment = 'unfulfilled', tracking_number = NULL, tracking_url = NULL, shipped_at = NULL, updated_at = datetime('now') WHERE id = ?`,
      [orderId],
    );
    return;
  }
  execute(
    `UPDATE orders
     SET fulfillment = ?, tracking_number = ?, tracking_url = ?,
         shipped_at = COALESCE(shipped_at, datetime('now')), updated_at = datetime('now')
     WHERE id = ?`,
    [fulfillment, trackingNumber || null, trackingUrl || null, orderId],
  );
}

export function findOrdersByEmail(email: string): OrderRow[] {
  return query<OrderRow>(
    'SELECT * FROM orders WHERE lower(email) = lower(?) ORDER BY created_at DESC',
    [email],
  );
}

export function findOrderByIdAndEmail(id: string, email: string): OrderRow | null {
  return queryOne<OrderRow>(
    'SELECT * FROM orders WHERE id = ? AND lower(email) = lower(?)',
    [id, email],
  );
}
