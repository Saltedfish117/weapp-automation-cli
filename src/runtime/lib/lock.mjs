/**
 * Connection/session management.
 *
 * Hard rules baked in here:
 *  - never call mp.close() from normal commands: it shuts down the devtools
 *    instance the user has open. `up --restart` opts in explicitly.
 *  - checkVersion() is stubbed by default; older automator builds fail the
 *    version handshake against current devtools and the whole run dies.
 *  - a per-port lock keeps several agents (DSH, Codex, ...) from trampling
 *    each other on the single automation port.
 *
 * Lock rules:
 *  - a lock whose PID is alive is NEVER stolen, no matter how old it is;
 *    long runs are legitimate. Use `lock clear --force` if the PID was reused.
 *  - a lock is created with O_EXCL (atomic), so two processes cannot both win.
 *  - the holder touches mtime every 10s as a heartbeat; the age is only used
 *    for corrupt/legacy locks without a usable PID.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CliError, EXIT, log } from './output.mjs';
import { PACKAGE_ROOT } from '../../package.mjs';

const require = createRequire(import.meta.url);
export { PACKAGE_ROOT };

/** Only used when the lock has no usable PID (corrupt/legacy file). */
const UNREADABLE_LOCK_TTL_MS = 30_000;
const HEARTBEAT_MS = 10_000;

export function loadAutomator() {
  try {
    const automator = require('miniprogram-automator');
    const Connection = require('miniprogram-automator/out/Connection').default;
    const MiniProgram = require('miniprogram-automator/out/MiniProgram').default;
    const pkg = require('miniprogram-automator/package.json');
    return { automator, Connection, MiniProgram, version: pkg.version };
  } catch (err) {
    throw new CliError(
      `miniprogram-automator cannot be loaded (${err.message}). Reinstall weapp-automation-cli with npm, then run weapp doctor.`,
      { exitCode: EXIT.CONFIG, code: 'missing-dependency' },
    );
  }
}

/** TCP probe: is the devtools automation port listening? */
export function probePort(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('close', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export function lockPath(port) {
  return path.join(os.tmpdir(), `weapp-automation-${port}.lock`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function parseLockBody(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      return {
        pid: Number.parseInt(String(parsed.pid), 10),
        command: typeof parsed.command === 'string' ? parsed.command : null,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      };
    }
  } catch {
    /* legacy "pid iso" format */
  }
  const pid = Number.parseInt(String(body).trim().split(/\s+/)[0], 10);
  return { pid, command: null, cwd: null, startedAt: null };
}

/** @returns {{file:string, age:number, mtimeMs:number, body:string, pid:number, alive:boolean, stale:boolean, command:string|null, cwd:string|null, startedAt:string|null}|null} */
export function readLockInfo(port) {
  const file = lockPath(port);
  try {
    const stat = fs.statSync(file);
    const age = Date.now() - stat.mtimeMs;
    const body = fs.readFileSync(file, 'utf8').trim();
    const meta = parseLockBody(body);
    const alive = pidAlive(meta.pid);
    const hasPid = Number.isInteger(meta.pid) && meta.pid > 0;
    // A lock with a readable PID is never stale while that PID is alive.
    // A corrupt/legacy lock is only stale after the grace period, so a writer
    // that has created but not yet filled the file cannot be stolen instantly.
    const stale = hasPid ? !alive : age > UNREADABLE_LOCK_TTL_MS;
    return { file, age, mtimeMs: stat.mtimeMs, body, ...meta, alive, stale };
  } catch {
    return null;
  }
}

function describeLock(info) {
  if (!info) return 'unknown';
  const who = info.body || `pid ${info.pid || '?'}`;
  const where = info.command ? ` command="${info.command}"` : '';
  return `pid ${info.pid || '?'} (${Math.round(info.age / 1000)}s old, alive=${info.alive}) ${who}${where}`;
}

function writeLock(file, command) {
  const payload = JSON.stringify({
    pid: process.pid,
    command: command || process.argv.slice(2).join(' '),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  });
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, payload, 0, 'utf8');
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw new CliError(`cannot create lock ${file}: ${err.message}`, {
      exitCode: EXIT.RUNTIME,
      code: 'lock-failed',
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function lockIsOurs(file) {
  try {
    const parsed = parseLockBody(fs.readFileSync(file, 'utf8'));
    return parsed.pid === process.pid;
  } catch {
    return false;
  }
}

function removeStaleLock(info) {
  // Re-check mtime right before unlinking so we never delete a lock that was
  // legitimately replaced between readLockInfo() and here.
  try {
    const stat = fs.statSync(info.file);
    if (stat.mtimeMs !== info.mtimeMs) return false;
    fs.unlinkSync(info.file);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(port, { waitMs = 8000, command = '' } = {}) {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new CliError(`invalid lock wait: ${waitMs}`, {
      exitCode: EXIT.CONFIG,
      code: 'bad-lock-wait',
    });
  }

  const file = lockPath(port);
  const deadline = Date.now() + waitMs;
  let announced = false;

  for (;;) {
    const info = readLockInfo(port);
    if (!info) {
      if (writeLock(file, command)) return startHeartbeat(file);
      await new Promise((r) => setTimeout(r, 100));
      continue;
    } else if (info.stale) {
      log(
        `[weapp] clearing stale lock ${file} (${info.alive ? `${Math.round(info.age / 1000)}s old` : `holder pid ${info.pid || '?'} is gone`})`,
      );
      if (!removeStaleLock(info)) {
        if (Date.now() >= deadline) {
          throw new CliError(`port ${port} is busy: stale lock could not be cleared (${describeLock(info)})`, {
            exitCode: EXIT.UNREACHABLE,
            code: 'busy',
          });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      continue;
    } else if (Date.now() >= deadline) {
      throw new CliError(`port ${port} is busy: lock held by ${describeLock(info)}`, {
        exitCode: EXIT.UNREACHABLE,
        code: 'busy',
        data: {
          port,
          file,
          pid: info.pid,
          alive: info.alive,
          ageMs: info.age,
          command: info.command,
          cwd: info.cwd,
        },
      });
    }

    if (!announced) {
      log(`[weapp] waiting for port ${port} (held by ${describeLock(info)})`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function startHeartbeat(file) {
  const cleanup = () => {
    if (!lockIsOurs(file)) return; // another process stole/replaced it
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
  const timer = setInterval(() => {
    if (!lockIsOurs(file)) {
      clearInterval(timer);
      return;
    }
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      clearInterval(timer);
    }
  }, HEARTBEAT_MS);
  timer.unref();
  process.once('exit', cleanup);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    process.removeListener('exit', cleanup);
    cleanup();
  };
}
