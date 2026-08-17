import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { getUpdateStatus } from '../../src/admin/updates';
import { render } from '../../src/admin/render';

const base = path.join(os.tmpdir(), `taberno-upd-${randomUUID()}`);
const G = ['-c', 'user.email=t@t.com', '-c', 'user.name=Test'];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', [...G, ...args], { cwd, stdio: 'pipe' });
}

function commit(cwd: string, file: string, msg: string): void {
  fs.writeFileSync(path.join(cwd, file), msg);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', msg);
}

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('getUpdateStatus', () => {
  it('reports not-a-git-checkout for a plain directory', async () => {
    const dir = path.join(base, 'plain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    const s = await getUpdateStatus({ cwd: dir, force: true });
    expect(s.isGitCheckout).toBe(false);
    expect(s.updateAvailable).toBe(false);
    expect(s.currentVersion).toBe('0.2.0');
  });

  it('reports up-to-date, then behind after the remote advances', async () => {
    fs.mkdirSync(base, { recursive: true });
    const remote = path.join(base, 'remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=master', remote], { stdio: 'pipe' });

    // A working checkout at the tip of origin/master.
    const work = path.join(base, 'work');
    execFileSync('git', ['clone', remote, work], { stdio: 'pipe' });
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    commit(work, 'a.txt', 'first');
    git(work, 'push', 'origin', 'master');

    let s = await getUpdateStatus({ cwd: work, force: true });
    expect(s.isGitCheckout).toBe(true);
    expect(s.behind).toBe(0);
    expect(s.updateAvailable).toBe(false);
    expect(s.currentSha).toMatch(/^[0-9a-f]{40}$/);

    // Someone else pushes a newer commit — our checkout is now behind by one.
    const work2 = path.join(base, 'work2');
    execFileSync('git', ['clone', remote, work2], { stdio: 'pipe' });
    commit(work2, 'b.txt', 'second');
    git(work2, 'push', 'origin', 'master');

    s = await getUpdateStatus({ cwd: work, force: true });
    expect(s.behind).toBe(1);
    expect(s.updateAvailable).toBe(true);

    // The admin layout surfaces it (render injects the cached status).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reply = { generateCsrf: async () => 'tok' } as any;
    const html = await render('404', { admin: {}, settings: {} }, reply);
    expect(html).toContain('update is available');
  });
});
