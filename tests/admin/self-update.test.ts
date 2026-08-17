import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { performUpdate, migrationsChangedBetween } from '../../src/admin/self-update';

const base = path.join(os.tmpdir(), `taberno-selfupd-${randomUUID()}`);
const ID = ['-c', 'user.email=t@t.com', '-c', 'user.name=Test'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...ID, ...args], { cwd, stdio: 'pipe' }).toString().trim();
}
function head(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim();
}
function commit(cwd: string, file: string, content: string, msg: string): string {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', msg);
  return head(cwd);
}

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('migrationsChangedBetween (gates revert safety)', () => {
  it('is true when a migration file was added, false for code-only changes', async () => {
    const repo = path.join(base, 'mig');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=master', repo], { stdio: 'pipe' });
    const c0 = commit(repo, 'README.md', 'hi', 'init');
    const c1 = commit(repo, 'src/db/migrations/026_thing.sql', 'CREATE TABLE t(x);', 'add migration');
    const c2 = commit(repo, 'src/routes/foo.ts', 'export const x = 1;', 'code only');

    expect(await migrationsChangedBetween(repo, c0, c1)).toBe(true);
    expect(await migrationsChangedBetween(repo, c1, c2)).toBe(false);
  });
});

describe('performUpdate', () => {
  it('advances to origin/master on a successful build, and rolls back on a failed one', async () => {
    const remote = path.join(base, 'remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=master', remote], { stdio: 'pipe' });

    const work = path.join(base, 'work');
    execFileSync('git', ['clone', remote, work], { stdio: 'pipe' });
    commit(work, 'a.txt', 'v1', 'first');
    git(work, 'push', 'origin', 'master');

    // A newer commit lands on the remote.
    const work2 = path.join(base, 'work2');
    execFileSync('git', ['clone', remote, work2], { stdio: 'pipe' });
    commit(work2, 'a.txt', 'v2', 'second');
    git(work2, 'push', 'origin', 'master');

    const startSha = head(work);

    // Build fails → checkout must be reset back to where it started.
    await expect(
      performUpdate(work, { build: async () => { throw new Error('build blew up'); } }),
    ).rejects.toThrow('build blew up');
    expect(head(work)).toBe(startSha); // rolled back — never left on the broken pull

    // Build succeeds → checkout advances to the new commit.
    const res = await performUpdate(work, { build: async () => { /* ok */ } });
    expect(res.fromSha).toBe(startSha);
    expect(res.toSha).not.toBe(startSha);
    expect(head(work)).toBe(res.toSha);
  });

  it('pulls cleanly even when package-lock.json was left modified by a prior npm install', async () => {
    const remote = path.join(base, 'lock-remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=master', remote], { stdio: 'pipe' });

    const work = path.join(base, 'lock-work');
    execFileSync('git', ['clone', remote, work], { stdio: 'pipe' });
    commit(work, 'package-lock.json', '{"version":"1"}', 'first');
    git(work, 'push', 'origin', 'master');

    // A newer commit bumps the lockfile on the remote (as the release workflow does).
    const work2 = path.join(base, 'lock-work2');
    execFileSync('git', ['clone', remote, work2], { stdio: 'pipe' });
    commit(work2, 'package-lock.json', '{"version":"2"}', 'bump');
    git(work2, 'push', 'origin', 'master');

    // Simulate `npm install` churning the lockfile locally — this is what used to
    // make `git pull --ff-only` abort.
    fs.writeFileSync(path.join(work, 'package-lock.json'), '{"version":"local-churn"}');

    const res = await performUpdate(work, { build: async () => { /* ok */ } });
    expect(res.toSha).not.toBe(res.fromSha);            // advanced despite the dirty lockfile
    expect(fs.readFileSync(path.join(work, 'package-lock.json'), 'utf-8')).toBe('{"version":"2"}');
  });
});
