import { randomUUID } from 'crypto';
import { query, execute } from '../connection';

export type LogType = 'payment' | 'error' | 'atproto';
export type LogLevel = 'info' | 'warn' | 'error';

export interface SystemLogRow {
  id: string;
  type: LogType;
  level: LogLevel;
  message: string;
  meta: string | null;
  created_at: string;
}

export function writeLog(
  type: LogType,
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
): void {
  try {
    execute(
      `INSERT INTO system_log (id, type, level, message, meta) VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), type, level, message, meta ? JSON.stringify(meta) : null],
    );
  } catch {
    // Never let logging crash the app
  }
}

export function listLogs(type: LogType, limit = 50): SystemLogRow[] {
  return query<SystemLogRow>(
    `SELECT * FROM system_log WHERE type = ? ORDER BY created_at DESC LIMIT ?`,
    [type, limit],
  );
}

export function listAllLogs(limit = 100): SystemLogRow[] {
  return query<SystemLogRow>(
    `SELECT * FROM system_log ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
}
