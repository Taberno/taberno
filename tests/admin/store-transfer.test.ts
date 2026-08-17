import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import AdmZip from 'adm-zip';
import {
  exportStore,
  stageStoreImport,
  checkSchemaCompatibility,
} from '../../src/admin/store-transfer';
import { STAGING_DIR } from '../../src/db/pending-import';
import { listMigrationFilenames } from '../../src/db/migrate';
import { setSetting } from '../../src/db/queries/admin';

const tmpDirs: string[] = [];
afterEach(() => {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('checkSchemaCompatibility', () => {
  const available = ['001_a.sql', '002_b.sql', '003_c.sql'];

  it('accepts an export with the same migrations', () => {
    expect(checkSchemaCompatibility(available, available)).toEqual({ ok: true });
  });

  it('accepts an older export (subset of what this build has)', () => {
    expect(checkSchemaCompatibility(['001_a.sql', '002_b.sql'], available)).toEqual({ ok: true });
  });

  it('rejects a newer export that has migrations this build lacks', () => {
    const res = checkSchemaCompatibility([...available, '004_future.sql'], available);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('newer');
    expect(res.missing).toEqual(['004_future.sql']);
  });
});

describe('exportStore → stageStoreImport round trip', () => {
  it('exports a valid archive and stages it back', async () => {
    setSetting('store_name', 'Round Trip Test Store');

    const { zipPath, dir } = await exportStore({ includeDigitalFiles: false });
    tmpDirs.push(dir);

    // The archive is well-formed.
    const zip = new AdmZip(zipPath);
    expect(zip.getEntry('store.db')).toBeTruthy();
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString());
    expect(manifest.format).toBe('taberno-store-export');
    expect(manifest.migrations).toEqual(listMigrationFilenames());
    expect(manifest.migrations.length).toBeGreaterThan(0);

    // Staging accepts it and lays down the database ready for boot-time apply.
    const buffer = fs.readFileSync(zipPath);
    const { manifest: staged } = await stageStoreImport(buffer);
    expect(staged.tabernoVersion).toBe(manifest.tabernoVersion);
    expect(fs.existsSync(`${STAGING_DIR}/store.db`)).toBe(true);
  });
});

describe('stageStoreImport validation', () => {
  it('rejects a zip that is not a taberno export', async () => {
    const zip = new AdmZip();
    zip.addFile('random.txt', Buffer.from('hello'));
    await expect(stageStoreImport(zip.toBuffer())).rejects.toThrow(/not a taberno store export/i);
  });

  it('rejects an export made with a newer taberno (unknown migrations)', async () => {
    const zip = new AdmZip();
    zip.addFile('store.db', Buffer.from('SQLite format 3\0'));
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({
      format: 'taberno-store-export',
      formatVersion: 1,
      tabernoVersion: '99.0.0',
      migrations: [...listMigrationFilenames(), '999_from_the_future.sql'],
      createdAt: new Date().toISOString(),
      includes: { uploads: false, digitalFiles: false, themes: [] },
      counts: {},
    })));
    await expect(stageStoreImport(zip.toBuffer())).rejects.toThrow(/newer version/i);
    // On rejection nothing is left staged.
    expect(fs.existsSync(`${STAGING_DIR}/store.db`)).toBe(false);
  });
});
