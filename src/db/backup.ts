import fs from 'fs';
import path from 'path';
import { db } from './connection';
import config from '../config';

/**
 * Creates a consistent snapshot of the live SQLite database using SQLite's
 * online backup API (safe to run while the server is serving traffic — no need
 * to stop it). Writes to `backups/store-<timestamp>.db` under the project root
 * by default, or to a path given as the first CLI argument.
 *
 *   npm run db:backup                 → backups/store-20260727-104512.db
 *   npm run db:backup /mnt/vol/x.db   → /mnt/vol/x.db
 *
 * Schedule it with cron for regular snapshots, e.g. hourly:
 *   0 * * * * cd /app && /usr/bin/npm run db:backup >> /var/log/taberno-backup.log 2>&1
 */
async function main(): Promise<void> {
  const arg = process.argv[2];
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('') + '-' + [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

  const dest = arg
    ? path.resolve(process.cwd(), arg)
    : path.resolve(process.cwd(), 'backups', `store-${stamp}.db`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  console.log(`Backing up ${config.databasePath} → ${dest}`);
  await db.backup(dest);
  const { size } = fs.statSync(dest);
  console.log(`Done — ${(size / 1024 / 1024).toFixed(2)} MB written.`);
}

main().catch((err) => {
  console.error('Backup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
