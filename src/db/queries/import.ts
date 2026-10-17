import { query, queryOne, execute } from '../connection';
import { scheduleSync } from '../../atproto/scheduler';

export interface ImportJobRow {
  id: string;
  source: string;
  status: string;
  stage: string;
  total: number;
  processed: number;
  errors: string;
  created_at: string;
  finished_at: string | null;
}

export function createImportJob(source: string): string {
  const id = crypto.randomUUID();
  execute('INSERT INTO import_jobs (id, source, stage) VALUES (?, ?, ?)', [id, source, 'Starting...']);
  return id;
}

export function updateImportJobProgress(id: string, stage: string, total: number, processed: number): void {
  execute('UPDATE import_jobs SET stage = ?, total = ?, processed = ? WHERE id = ?', [stage, total, processed, id]);
}

export function appendImportJobError(id: string, item: string, message: string): void {
  const row = queryOne<{ errors: string }>('SELECT errors FROM import_jobs WHERE id = ?', [id]);
  const errors = row ? JSON.parse(row.errors) : [];
  errors.push({ item, message });
  execute('UPDATE import_jobs SET errors = ? WHERE id = ?', [JSON.stringify(errors), id]);
}

export function finishImportJob(id: string, status: 'completed' | 'failed', stage: string): void {
  execute(
    `UPDATE import_jobs SET status = ?, stage = ?, finished_at = datetime('now') WHERE id = ?`,
    [status, stage, id],
  );
  // Imports finish long after the admin request that started them.
  if (status === 'completed') scheduleSync('import');
}

export function findImportJob(id: string): ImportJobRow | null {
  return queryOne<ImportJobRow>('SELECT * FROM import_jobs WHERE id = ?', [id]);
}

export function listRecentImportJobs(limit = 10): ImportJobRow[] {
  return query<ImportJobRow>('SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT ?', [limit]);
}
