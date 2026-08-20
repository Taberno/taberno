-- URL redirects. Chiefly for WooCommerce migration: a Woo shop's old URL shapes
-- (/product/<slug>/, /product-category/<slug>/, /?p=<id>) 404 on this platform,
-- losing years of Google ranking and inbound links. The importer records the old
-- path for every product, category and page it brings across and 301s it to the
-- new URL, so rankings and links survive the switch. Merchants can also add their
-- own. `from_path` is a path (+ optional query) with no host, already normalised
-- (lowercased, no trailing slash); the UNIQUE index doubles as the lookup index.
CREATE TABLE redirects (
  id         TEXT PRIMARY KEY,
  from_path  TEXT NOT NULL UNIQUE,             -- '/product/blue-widget' or '/?p=42'
  to_path    TEXT NOT NULL,                    -- '/products/blue-widget'
  source     TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'woocommerce-import'
  hits       INTEGER NOT NULL DEFAULT 0,       -- times served — shows the redirect is earning its keep
  created_at TEXT DEFAULT (datetime('now'))
);
