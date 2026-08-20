import { describe, it, expect } from 'vitest';
import { parseWxr } from '../../../src/import/woocommerce/wxr';

function wrap(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>My Test Store</title>
<link>https://example.com</link>
<description>A test store</description>
${items}
</channel>
</rss>`;
}

describe('parseWxr', () => {
  it('warns and returns empty results for a file with no relevant content', () => {
    const result = parseWxr(wrap(''));
    expect(result.products).toEqual([]);
    expect(result.pages).toEqual([]);
    expect(result.orders).toEqual([]);
    expect(result.warnings).toEqual(['No WooCommerce products, orders or pages found in this export file.']);
    expect(result.siteInfo).toEqual({ name: 'My Test Store', url: 'https://example.com', description: 'A test store' });
  });

  it('parses a product with price, sale, images, categories and stock', () => {
    const xml = wrap(`
      <item>
        <title>Attachment Thumb</title>
        <wp:post_id>50</wp:post_id>
        <wp:post_type>attachment</wp:post_type>
        <wp:attachment_url>https://example.com/uploads/thumb.jpg</wp:attachment_url>
      </item>
      <item>
        <title>Attachment Gallery</title>
        <wp:post_id>51</wp:post_id>
        <wp:post_type>attachment</wp:post_type>
        <wp:attachment_url>https://example.com/uploads/gallery1.jpg</wp:attachment_url>
      </item>
      <item>
        <title>Cool T-Shirt</title>
        <content:encoded><![CDATA[<p>A great shirt.</p>]]></content:encoded>
        <wp:post_id>10</wp:post_id>
        <wp:post_type>product</wp:post_type>
        <wp:post_name>cool-t-shirt</wp:post_name>
        <wp:status>publish</wp:status>
        <category domain="product_cat" nicename="apparel"><![CDATA[Apparel]]></category>
        <wp:postmeta><wp:meta_key>_regular_price</wp:meta_key><wp:meta_value>29.99</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_sale_price</wp:meta_key><wp:meta_value>19.99</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_sku</wp:meta_key><wp:meta_value>SHIRT-1</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>50</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_product_image_gallery</wp:meta_key><wp:meta_value>51,50</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_stock</wp:meta_key><wp:meta_value>5</wp:meta_value></wp:postmeta>
      </item>
    `);

    const { products, warnings } = parseWxr(xml);
    expect(warnings).toEqual([]);
    expect(products).toHaveLength(1);

    const product = products[0];
    expect(product).toMatchObject({
      wcId: 10,
      title: 'Cool T-Shirt',
      slug: 'cool-t-shirt',
      sku: 'SHIRT-1',
      published: true,
      stockQuantity: 5,
    });
    // On sale: sale (19.99) < regular (29.99) -> price is the sale price, compareAt is regular
    expect(product.price).toBe(19.99);
    expect(product.compareAtPrice).toBe(29.99);
    expect(product.categories).toEqual([{ wcId: null, name: 'Apparel', slug: 'apparel' }]);
    // Thumbnail first, then gallery — deduped against the thumbnail's own URL
    expect(product.images).toEqual([
      { url: 'https://example.com/uploads/thumb.jpg', alt: 'Cool T-Shirt' },
      { url: 'https://example.com/uploads/gallery1.jpg', alt: 'Cool T-Shirt' },
    ]);
  });

  it('excludes trashed products', () => {
    const xml = wrap(`
      <item>
        <title>Discontinued</title>
        <wp:post_id>11</wp:post_id>
        <wp:post_type>product</wp:post_type>
        <wp:status>trash</wp:status>
      </item>
    `);
    expect(parseWxr(xml).products).toEqual([]);
  });

  it('builds a variation from attribute_* postmeta, deriving options and a joined title', () => {
    const xml = wrap(`
      <item>
        <title>Cool Hoodie</title>
        <wp:post_id>12</wp:post_id>
        <wp:post_type>product</wp:post_type>
        <wp:post_name>cool-hoodie</wp:post_name>
        <wp:status>publish</wp:status>
      </item>
      <item>
        <title>Variation #12</title>
        <wp:post_id>13</wp:post_id>
        <wp:post_type>product_variation</wp:post_type>
        <wp:post_parent>12</wp:post_parent>
        <wp:status>publish</wp:status>
        <wp:postmeta><wp:meta_key>_regular_price</wp:meta_key><wp:meta_value>45.00</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_sku</wp:meta_key><wp:meta_value>HOODIE-L-BLU</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>attribute_pa_size</wp:meta_key><wp:meta_value>l</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>attribute_pa_color</wp:meta_key><wp:meta_value>blue</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_stock</wp:meta_key><wp:meta_value>2</wp:meta_value></wp:postmeta>
      </item>
    `);

    const { products } = parseWxr(xml);
    expect(products).toHaveLength(1);
    expect(products[0].variations).toEqual([{
      wcId: 13,
      title: 'l / blue',
      price: 45,
      compareAtPrice: null,
      sku: 'HOODIE-L-BLU',
      stockQuantity: 2,
      options: { Size: 'l', Color: 'blue' },
      image: null,
    }]);
  });

  it('parses a page including its excerpt, and defaults slug when post_name is blank', () => {
    const xml = wrap(`
      <item>
        <title>About Us</title>
        <content:encoded><![CDATA[<p>About our store.</p>]]></content:encoded>
        <excerpt:encoded><![CDATA[Short excerpt]]></excerpt:encoded>
        <wp:post_id>20</wp:post_id>
        <wp:post_type>page</wp:post_type>
        <wp:post_name>about-us</wp:post_name>
        <wp:status>publish</wp:status>
      </item>
      <item>
        <title>No Slug Page</title>
        <wp:post_id>21</wp:post_id>
        <wp:post_type>page</wp:post_type>
        <wp:post_name></wp:post_name>
        <wp:status>draft</wp:status>
      </item>
    `);

    const { pages } = parseWxr(xml);
    expect(pages).toEqual([
      { wcId: 20, permalink: null, title: 'About Us', slug: 'about-us', content: '<p>About our store.</p>', excerpt: 'Short excerpt', status: 'published' },
      { wcId: 21, permalink: null, title: 'No Slug Page', slug: 'page-21', content: '', excerpt: '', status: 'draft' },
    ]);
  });

  it('maps a WooCommerce order: status vocabulary, pence conversion, and billing address', () => {
    const xml = wrap(`
      <item>
        <title>1001</title>
        <wp:post_id>30</wp:post_id>
        <wp:post_type>shop_order</wp:post_type>
        <wp:status>wc-completed</wp:status>
        <wp:post_date_gmt>2026-01-15 10:00:00</wp:post_date_gmt>
        <wp:postmeta><wp:meta_key>_order_total</wp:meta_key><wp:meta_value>29.99</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_order_shipping</wp:meta_key><wp:meta_value>4.99</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_billing_email</wp:meta_key><wp:meta_value>jane@example.com</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_billing_first_name</wp:meta_key><wp:meta_value>Jane</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_billing_country</wp:meta_key><wp:meta_value>GB</wp:meta_value></wp:postmeta>
      </item>
    `);

    const { orders } = parseWxr(xml);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      wcId: 30,
      orderNumber: 1001,
      email: 'jane@example.com',
      status: 'paid',           // wc-completed -> paid
      total: 2999,              // pence
      shipping: 499,
      subtotal: 2500,           // total - shipping - tax(0)
      billingAddress: { first_name: 'Jane', country: 'GB', email: 'jane@example.com' },
    });
  });
});
