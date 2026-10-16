import { getSetting } from '../db/queries/admin';
import { writeLog } from '../db/queries/system-log';
import type { RepoClient } from './repo';
import * as state from './state';

// When syncs run. Catalogue changes call scheduleSync(), which waits for 30 s
// of quiet so a burst of edits becomes one sync. An hourly full sync catches
// anything else (stock changes, edits made outside the admin, repo drift).
// Only one sync runs at a time; a request during a run queues one more.
//
// Kept light on imports: scheduleSync() is called from hot paths like order
// payment, so the sync and OAuth code load only when a sync actually runs.

const DEBOUNCE_MS = 30_000;
const HOURLY_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let queued: { trigger: string; full: boolean } | null = null;
let repoFactory: (() => Promise<RepoClient>) | null = null;

/** Tests swap in an in-memory repo. */
export function setRepoFactory(factory: (() => Promise<RepoClient>) | null): void {
  repoFactory = factory;
}

export function isEnabled(): boolean {
  return getSetting('atproto_enabled') === '1' && state.getAccount() !== null;
}

export function scheduleSync(trigger = 'change', delayMs = DEBOUNCE_MS): void {
  try {
    if (!isEnabled()) return;
  } catch {
    return; // never let publishing get in the way of the request that triggered it
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncNow(trigger, false);
  }, delayMs);
  timer.unref?.();
}

export function syncNow(trigger: string, full: boolean): Promise<void> {
  if (running) {
    queued = { trigger, full: full || (queued?.full ?? false) };
    return running;
  }
  running = runOnce(trigger, full).finally(() => {
    running = null;
    if (queued) {
      const next = queued;
      queued = null;
      void syncNow(next.trigger, next.full);
    }
  });
  return running;
}

async function runOnce(trigger: string, full: boolean): Promise<void> {
  const runId = state.startRun(trigger);
  try {
    const repo = repoFactory ? await repoFactory() : await (await import('./oauth')).repoClientForAccount();
    const { syncCatalogue } = await import('./sync');
    const res = await syncCatalogue(repo, { full });
    const parts = [
      res.skipped.length ? `${res.skipped.length} invalid: ${res.skipped.map((s) => `${s.key} (${s.error})`).join('; ')}` : '',
      res.untracked ? `${res.untracked} records on the account were not written by this store and were left alone` : '',
    ].filter(Boolean);
    state.finishRun(runId, 'completed', { ...res, skipped: res.skipped.length }, parts.join('. ') || null);
    for (const s of res.skipped) writeLog('atproto', 'warn', `Not published: ${s.key}`, { error: s.error });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.finishRun(runId, 'failed', null, message);
    writeLog('atproto', 'error', `Sync failed: ${message}`, { trigger });
  }
}

export function startAtprotoSync(): void {
  state.failStaleRuns();
  const tick = (trigger: string) => {
    if (isEnabled()) void syncNow(trigger, true);
  };
  setTimeout(() => tick('startup'), 60_000).unref();
  setInterval(() => tick('hourly'), HOURLY_MS).unref();
}

/** For tests: wait for any running or queued sync to finish. */
export async function idle(): Promise<void> {
  while (running) await running;
}
