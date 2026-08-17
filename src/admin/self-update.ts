import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import config from '../config';

/**
 * One-click self-update for git-checkout deploys running under a supervisor
 * (systemd/pm2) that restarts the process on exit.
 *
 * Safety model:
 *  - Build BEFORE restart. `git pull` → `npm install` → `npm run build` all run
 *    while the old code keeps serving. Only on success do we exit and let the
 *    supervisor bring up the new code.
 *  - Roll back on any failure. A bad commit / failed build / broken native dep
 *    resets the checkout to where it started, so the store never restarts into
 *    broken code — it just keeps running the old version and reports the error.
 *  - Revert is offered afterwards, but only when no migration changed (taberno's
 *    migrations are forward-only, so reverting code without reverting schema is
 *    unsafe).
 */

const exec = promisify(execFile);
const STATUS_FILE = path.join(path.dirname(config.databasePath), '.update-status.json');
const REVERT_WINDOW_MS = 30 * 60 * 1000;
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

export type UpdateState = 'idle' | 'running' | 'success' | 'failed';

export interface UpdateJob {
  state: UpdateState;
  kind: 'update' | 'revert' | null;
  step: string;
  fromSha: string | null; // commit we started at — the revert target
  toSha: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function emptyJob(): UpdateJob {
  return { state: 'idle', kind: null, step: '', fromSha: null, toSha: null, error: null, startedAt: null, finishedAt: null };
}

export function readJob(): UpdateJob {
  try { return { ...emptyJob(), ...JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')) }; }
  catch { return emptyJob(); }
}

function writeJob(job: UpdateJob): void {
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(job, null, 2)); } catch { /* best effort */ }
}

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, timeout: timeoutMs });
  return stdout.trim();
}

/** Did any migration file change between two commits? Gates whether revert is safe. */
export async function migrationsChangedBetween(cwd: string, a: string, b: string): Promise<boolean> {
  try {
    const out = await git(cwd, ['diff', '--name-only', a, b, '--', 'src/db/migrations']);
    return out.trim().length > 0;
  } catch {
    return true; // if we can't tell, assume it did — safer to block revert
  }
}

export interface UpdateDeps {
  build: (cwd: string) => Promise<void>;
}

async function defaultBuild(cwd: string): Promise<void> {
  await exec('npm', ['install', '--no-audit', '--no-fund'], { cwd, timeout: STEP_TIMEOUT_MS });
  await exec('npm', ['run', 'build'], { cwd, timeout: STEP_TIMEOUT_MS });
}

const defaultDeps: UpdateDeps = { build: defaultBuild };

/**
 * Pulls origin/master and rebuilds. On a build failure the checkout is reset
 * back to `fromSha` and rebuilt, so the running install is left exactly as it
 * was. Never restarts here — the caller decides that only on success.
 */
export async function performUpdate(cwd: string, deps: UpdateDeps = defaultDeps): Promise<{ fromSha: string; toSha: string }> {
  const fromSha = await git(cwd, ['rev-parse', 'HEAD']);
  await git(cwd, ['fetch', '--quiet', 'origin', 'master']);
  // `npm install` (in the build step) rewrites package-lock.json, and the release
  // workflow bumps package-lock.json + package.json on every version. Left
  // together, the server's locally-churned lockfile makes `git pull --ff-only`
  // abort with "local changes would be overwritten". Discard that churn first —
  // the pulled + rebuilt versions are authoritative. Ignored if the files are
  // absent/unchanged. Done per-file so a missing one can't block the other.
  await git(cwd, ['checkout', '--', 'package-lock.json']).catch(() => { /* nothing to discard */ });
  await git(cwd, ['checkout', '--', 'package.json']).catch(() => { /* nothing to discard */ });
  await git(cwd, ['pull', '--ff-only', 'origin', 'master']);

  try {
    await deps.build(cwd);
  } catch (err) {
    await git(cwd, ['reset', '--hard', fromSha]);
    await deps.build(cwd).catch(() => { /* best-effort restore of the old build */ });
    throw err;
  }

  const toSha = await git(cwd, ['rev-parse', 'HEAD']);
  return { fromSha, toSha };
}

/** Resets the checkout to `toSha` and rebuilds (the revert target already built before, so this should succeed). */
export async function performRevert(cwd: string, toSha: string, deps: UpdateDeps = defaultDeps): Promise<{ fromSha: string; toSha: string }> {
  const fromSha = await git(cwd, ['rev-parse', 'HEAD']);
  await git(cwd, ['reset', '--hard', toSha]);
  await deps.build(cwd);
  return { fromSha, toSha };
}

export interface RevertAvailability {
  available: boolean;
  reason?: 'no_recent_update' | 'window_expired' | 'migrations_changed';
  toSha?: string | null;
}

/** Whether a "revert" button should be shown for the last successful update. */
export async function revertAvailability(cwd: string): Promise<RevertAvailability> {
  const job = readJob();
  if (job.state !== 'success' || job.kind !== 'update' || !job.fromSha || !job.finishedAt) {
    return { available: false, reason: 'no_recent_update' };
  }
  if (Date.now() - new Date(job.finishedAt).getTime() > REVERT_WINDOW_MS) {
    return { available: false, reason: 'window_expired' };
  }
  if (await migrationsChangedBetween(cwd, job.fromSha, 'HEAD')) {
    return { available: false, reason: 'migrations_changed', toSha: job.fromSha };
  }
  return { available: true, toSha: job.fromSha };
}

// ── Background orchestration ──────────────────────────────────────────────────

function runInBackground(kind: 'update' | 'revert', work: () => Promise<{ fromSha: string; toSha: string }>): void {
  const job: UpdateJob = {
    state: 'running', kind, step: 'Pulling and building…',
    fromSha: null, toSha: null, error: null,
    startedAt: new Date().toISOString(), finishedAt: null,
  };
  writeJob(job);

  void (async () => {
    try {
      const { fromSha, toSha } = await work();
      writeJob({ ...job, state: 'success', fromSha, toSha, step: 'Complete — restarting…', finishedAt: new Date().toISOString() });
      // Exit so the supervisor restarts into the new/reverted code.
      setTimeout(() => process.exit(0), 800);
    } catch (err) {
      writeJob({ ...job, state: 'failed', error: err instanceof Error ? err.message : String(err), step: 'Failed — rolled back to the previous version', finishedAt: new Date().toISOString() });
    }
  })();
}

/** Kicks off an update in the background. Returns immediately; poll readJob() for progress. */
export function startUpdate(cwd = process.cwd()): { ok: boolean; error?: string } {
  if (readJob().state === 'running') return { ok: false, error: 'An update is already in progress.' };
  runInBackground('update', () => performUpdate(cwd));
  return { ok: true };
}

/** Kicks off a revert to the last pre-update commit, if it's still safe. */
export async function startRevert(cwd = process.cwd()): Promise<{ ok: boolean; error?: string }> {
  if (readJob().state === 'running') return { ok: false, error: 'An update is already in progress.' };
  const avail = await revertAvailability(cwd);
  if (!avail.available || !avail.toSha) {
    return { ok: false, error: avail.reason === 'migrations_changed'
      ? 'Revert is unavailable: this update changed the database schema, which can\'t be safely undone.'
      : 'Nothing to revert.' };
  }
  runInBackground('revert', () => performRevert(cwd, avail.toSha!));
  return { ok: true };
}
