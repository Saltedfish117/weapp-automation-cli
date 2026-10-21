import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { acquireLock, lockPath, readLockInfo } from '../src/runtime/lib/lock.mjs';

function writeLock(port, pid, command) {
  const file = lockPath(port);
  fs.writeFileSync(
    file,
    JSON.stringify({ pid, command, cwd: process.cwd(), startedAt: new Date().toISOString() }),
    'utf8',
  );
  return file;
}

function cleanup(port) {
  try {
    fs.unlinkSync(lockPath(port));
  } catch {
    /* absent */
  }
}

test('a live PID lock is never stolen', async () => {
  const port = 9611;
  cleanup(port);
  const file = writeLock(port, process.pid, 'live-holder');
  await assert.rejects(
    acquireLock(port, { waitMs: 120 }),
    (err) => err.code === 'busy' && err.exitCode === 3,
  );
  assert.equal(fs.existsSync(file), true);
  const info = readLockInfo(port);
  assert.equal(info.alive, true);
  assert.equal(info.stale, false);
  cleanup(port);
});

test('a dead PID lock is stolen and released', async () => {
  const port = 9612;
  cleanup(port);
  writeLock(port, 999999, 'dead-holder');
  const release = await acquireLock(port, { waitMs: 1000 });
  const info = readLockInfo(port);
  assert.equal(info.pid, process.pid);
  assert.equal(info.alive, true);
  release();
  assert.equal(fs.existsSync(lockPath(port)), false);
  cleanup(port);
});

test('a lock file without a usable PID is stale only after the grace period', () => {
  const port = 9613;
  cleanup(port);
  const file = lockPath(port);
  fs.writeFileSync(file, 'not-a-pid', 'utf8');
  const fresh = readLockInfo(port);
  assert.equal(fresh.stale, false);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  const stale = readLockInfo(port);
  assert.equal(stale.stale, true);
  cleanup(port);
});
