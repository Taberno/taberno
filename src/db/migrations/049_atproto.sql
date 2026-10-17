-- AT Protocol publishing (optional, off by default).
--
-- Publishes the store's published products to the store's own atproto repo as
-- shop.lgtm.commerce.* records, so open directories such as Atmarket can list
-- them. Taberno stays the source of truth: a sync job diffs the catalogue
-- against what it last published and writes only the difference.

-- The connected account. One per store.
CREATE TABLE atproto_account (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  did          TEXT NOT NULL,
  handle       TEXT,
  pds          TEXT,
  connected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OAuth client key, in-flight login state and the session (tokens + DPoP key).
-- Values are AES-GCM encrypted with a key derived from SESSION_SECRET.
CREATE TABLE atproto_oauth_store (
  kind       TEXT NOT NULL,   -- 'client_key' | 'state' | 'session'
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, key)
);

-- What has been published: one row per record, keyed by what it represents
-- locally ('storefront', 'product:<id>', 'variant:<product id>:<sku|options>').
-- The rkey is chosen once and reused so edits update the same record.
CREATE TABLE atproto_records (
  local_key  TEXT NOT NULL,
  did        TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey       TEXT NOT NULL,
  hash       TEXT NOT NULL,   -- sha256 of the record as last written
  cid        TEXT,
  synced_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (did, local_key),
  UNIQUE (did, collection, rkey)
);

-- Uploaded images, keyed by a hash of the file, so an image is uploaded once
-- even when a re-import gives it a new id.
CREATE TABLE atproto_blobs (
  did         TEXT NOT NULL,
  file_hash   TEXT NOT NULL,
  blob        TEXT NOT NULL,  -- JSON blob ref as returned by uploadBlob
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (did, file_hash)
);

CREATE TABLE atproto_sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
  created     INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

INSERT OR IGNORE INTO store_settings (key, value) VALUES ('atproto_enabled', '0');
INSERT OR IGNORE INTO store_settings (key, value) VALUES ('atproto_directory_url', 'https://atmarket.co');
