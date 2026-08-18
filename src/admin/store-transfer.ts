import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import config from '../config';
import { db } from '../db/connection';
import { listMigrationFilenames } from '../db/migrate';
import { STAGING_DIR, READY_MARKER } from '../db/pending-import';

/**
 * Whole-store export / import. An export is a zip containing a consistent
 * database snapshot plus the on-disk assets; importing it replaces the target
 * store entirely (the swap happens at boot — see pending-import.ts). It's a
 * full clone, so the zip carries secrets and admin logins: treat it like a
 * password.
 */

/** What new exports are tagged with. */
export const EXPORT_FORMAT = 'taberno-store-export';

/**
 * Format tags this build will import.
 *
 * `squaark-store-export` is what every export taken before the August 2026
 * rename carries. The bytes are identical - only the label on them changed -
 * so refusing it would strand every backup a merchant already holds, including
 * the one they reach for the day something has gone badly wrong. That is the
 * only day an export matters, and it is the worst possible day to discover the
 * file is not accepted any more.
 *
 * There is no plan to remove this. It costs one entry in a set.
 */
export const ACCEPTED_FORMATS: ReadonlySet<string> = new Set([
  EXPORT_FORMAT,
  'squaark-store-export',
]);

export interface StoreManifest {
  format: string;
  formatVersion: number;
  /**
   * The build that produced the export. Recorded for support, never branched
   * on. Optional because exports predating the rename carry `squaarkVersion`
   * instead, and neither is read.
   */
  tabernoVersion?: string;
  squaarkVersion?: string;
  migrations: string[];
  createdAt: string;
  includes: { uploads: boolean; digitalFiles: boolean; themes: string[] };
  counts: Record<string, number>;
}

const BUNDLED_THEMES = new Set(['linen']);

function packageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function appliedMigrations(): string[] {
  try {
    return (db.prepare('SELECT filename FROM migrations ORDER BY filename').all() as { filename: string }[])
      .map(r => r.filename);
  } catch {
    return [];
  }
}

function storeCounts(): Record<string, number> {
  const count = (table: string): number => {
    try { return (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n; }
    catch { return 0; }
  };
  return {
    products: count('products'),
    collections: count('collections'),
    pages: count('pages'),
    orders: count('orders'),
    customers: count('customers'),
  };
}

/** Non-bundled (admin-uploaded) theme directories that must travel with the store. */
function customThemeDirs(): string[] {
  const themesRoot = path.resolve(process.cwd(), 'themes');
  if (!fs.existsSync(themesRoot)) return [];
  return fs.readdirSync(themesRoot).filter(slug =>
    !BUNDLED_THEMES.has(slug) && fs.statSync(path.join(themesRoot, slug)).isDirectory(),
  );
}

export interface ExportResult {
  /** Path to the written zip. Caller streams it, then removes `dir`. */
  zipPath: string;
  dir: string;
  filename: string;
}

export async function exportStore(opts: { includeDigitalFiles: boolean }): Promise<ExportResult> {
  const dir = path.join(os.tmpdir(), `taberno-export-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });

  // Consistent database snapshot (SQLite online backup — safe while serving).
  const snapshot = path.join(dir, 'store.db');
  await db.backup(snapshot);

  const zip = new AdmZip();
  zip.addLocalFile(snapshot); // → store.db at the zip root

  const includes: StoreManifest['includes'] = { uploads: false, digitalFiles: false, themes: [] };
  if (fs.existsSync(config.uploadsDir)) {
    zip.addLocalFolder(config.uploadsDir, 'uploads');
    includes.uploads = true;
  }
  if (opts.includeDigitalFiles && fs.existsSync(config.digitalFilesDir)) {
    zip.addLocalFolder(config.digitalFilesDir, 'digital-files');
    includes.digitalFiles = true;
  }
  const themesRoot = path.resolve(process.cwd(), 'themes');
  for (const slug of customThemeDirs()) {
    zip.addLocalFolder(path.join(themesRoot, slug), `themes/${slug}`);
    includes.themes.push(slug);
  }

  const manifest: StoreManifest = {
    format: EXPORT_FORMAT,
    formatVersion: 1,
    tabernoVersion: packageVersion(),
    migrations: appliedMigrations(),
    createdAt: new Date().toISOString(),
    includes,
    counts: storeCounts(),
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

  const zipPath = path.join(dir, 'store-export.zip');
  zip.writeZip(zipPath);
  fs.rmSync(snapshot, { force: true }); // keep only the zip

  const filename = `taberno-store-${manifest.createdAt.slice(0, 10)}.zip`;
  return { zipPath, dir, filename };
}

export interface SchemaCheck {
  ok: boolean;
  reason?: 'newer';
  missing?: string[];
}

/**
 * An export is safe to import when this build ships every migration the export
 * was made with (same-or-older schema — migrations run forward afterwards). If
 * the export references migrations this build doesn't have, it's newer and we
 * refuse rather than load a database our code can't understand.
 */
export function checkSchemaCompatibility(exportMigrations: string[], availableMigrations: string[]): SchemaCheck {
  const available = new Set(availableMigrations);
  const missing = exportMigrations.filter(m => !available.has(m));
  return missing.length ? { ok: false, reason: 'newer', missing } : { ok: true };
}

/**
 * Validates an uploaded export and extracts it into the staging directory.
 * Nothing is applied here — the swap happens on the next boot. Returns the
 * manifest so the caller can confirm to the user before restarting.
 */
export async function stageStoreImport(buffer: Buffer): Promise<{ manifest: StoreManifest }> {
  const zip = new AdmZip(buffer);

  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new Error('This file is not a Taberno store export (manifest.json missing).');
  let manifest: StoreManifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as StoreManifest;
  } catch {
    throw new Error('The export manifest is corrupt.');
  }
  if (!ACCEPTED_FORMATS.has(manifest.format)) {
    throw new Error('This file is not a Taberno store export.');
  }
  if (!zip.getEntry('store.db')) throw new Error('The export is missing its database (store.db).');

  const check = checkSchemaCompatibility(manifest.migrations ?? [], listMigrationFilenames());
  if (!check.ok) {
    throw new Error(
      'This export was made with a newer version of Taberno. Upgrade this server before importing.',
    );
  }

  // Fresh staging dir, extracting each file with zip-slip validation.
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  const stagingWithSep = STAGING_DIR + path.sep;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const dest = path.resolve(STAGING_DIR, entry.entryName);
    if (dest !== STAGING_DIR && !dest.startsWith(stagingWithSep)) {
      fs.rmSync(STAGING_DIR, { recursive: true, force: true });
      throw new Error(`Refusing to extract unsafe path from the zip: ${entry.entryName}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }

  // Written last: only now is the staging complete and safe to apply on boot.
  fs.writeFileSync(READY_MARKER, new Date().toISOString());
  return { manifest };
}
