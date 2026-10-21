/**
 * Open (attach or launch) a devtools automation session.
 */

import { CliError, EXIT, log, withTimeout } from './output.mjs';
import { acquireLock, loadAutomator, probePort } from './lock.mjs';
import { launchDevtools, waitForPortDown } from './launcher.mjs';
import { createDiagnostics } from './diagnostics.mjs';
import { createEvidence } from './evidence.mjs';

function duration(value, fallback, name, { allowZero = false } = {}) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') {
    throw new CliError(`${name} needs a numeric value`, {
      exitCode: EXIT.CONFIG,
      code: 'missing-flag-value',
    });
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new CliError(`invalid ${name}: "${value}"`, {
      exitCode: EXIT.CONFIG,
      code: 'bad-duration',
    });
  }
  return n;
}

/**
 * Disable mp.close() for normal commands. `--restart` keeps the original
 * function under __weappForceClose and calls it explicitly.
 */
function guardClose(mp) {
  if (!mp || mp.__weappCloseGuarded) return;
  const original = typeof mp.close === 'function' ? mp.close.bind(mp) : null;
  Object.defineProperty(mp, '__weappForceClose', { value: original, configurable: true });
  Object.defineProperty(mp, '__weappCloseGuarded', { value: true, configurable: true });
  mp.close = async () => {
    throw new CliError(
      'mp.close() is disabled by the weapp CLI because it would close WeChat DevTools. Use `up --restart` when a restart is really intended.',
      { exitCode: EXIT.ASSERT, code: 'close-disabled' },
    );
  };
}

function wrap({ mp, conn, mode, cliOutput, projectRoot, projectCheck }, release) {
  return {
    mp,
    conn,
    mode,
    cliOutput: cliOutput ?? null,
    projectRoot: projectRoot ?? null,
    projectCheck: projectCheck ?? null,
    forceClose: mp.__weappForceClose ?? null,
    async dispose() {
      try {
        if (conn && typeof conn.dispose === 'function') await conn.dispose();
        else if (mp && typeof mp.disconnect === 'function') await mp.disconnect();
      } catch (err) {
        log(`[weapp] dispose warning: ${err.message}`);
      } finally {
        release();
      }
    },
  };
}

/**
 * Compare the appid reported by the running mini program with project.config.
 * `Tool.getInfo` has no project path, but wx.getAccountInfoSync() exposes the
 * appid, which catches the common "attached to the wrong project window" case.
 */
async function readAppId(mp, timeoutMs) {
  try {
    const info = await withTimeout(
      mp.callWxMethod('getAccountInfoSync'),
      Math.min(Math.max(timeoutMs, 1000), 5000),
      'getAccountInfoSync',
    );
    return info?.miniProgram?.appId ?? null;
  } catch {
    return null;
  }
}

async function verifyProject(mp, config, flags, timeoutMs) {
  const expected = config.appid ?? null;
  const actual = await readAppId(mp, timeoutMs);
  const check = {
    expected,
    actual,
    matched: expected && actual ? expected === actual : null,
  };
  if (expected && actual && expected !== actual) {
    const message =
      `connected devtools mini program appid ${actual} does not match configured project ${expected} ` +
      `(check that DevTools has the right project window open)`;
    if (!flags['allow-other-project']) {
      throw new CliError(message, {
        exitCode: EXIT.UNREACHABLE,
        code: 'project-mismatch',
        data: check,
      });
    }
    log(`[weapp] WARNING: ${message}; continuing because --allow-other-project is set`);
  } else if (expected && !actual) {
    log('[weapp] warning: could not read appid via wx.getAccountInfoSync(); skipping project identity check');
  }
  return check;
}

export async function openSession(config, flags = {}) {
  const { Connection, MiniProgram } = loadAutomator();

  // Current devtools builds reject automator's version handshake; the ad-hoc
  // scripts that worked all stubbed this. Keep the stub unless asked otherwise.
  if (!flags['strict-version']) {
    MiniProgram.prototype.checkVersion = async () => {};
  }

  const port = config.port;
  const lockWait = duration(flags['lock-wait'], 8000, '--lock-wait', { allowZero: true });
  const release = await acquireLock(port, {
    waitMs: lockWait,
    command: process.argv.slice(2).join(' '),
  });
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };

  const connectTimeout = duration(flags['connect-timeout'], 8000, '--connect-timeout');
  const launchTimeout = duration(flags['launch-timeout'], 180_000, '--launch-timeout');

  const attach = async () => {
    let conn = null;
    try {
      conn = await withTimeout(
        Connection.create(`ws://127.0.0.1:${port}`),
        connectTimeout,
        `attach ws://127.0.0.1:${port}`,
      );
      const mp = new MiniProgram(conn);
      guardClose(mp);
      if (flags['strict-version']) {
        await withTimeout(mp.checkVersion(), connectTimeout, 'checkVersion');
      }
      // Round-trip once: a listening port does not guarantee a usable session.
      await withTimeout(mp.currentPage(), connectTimeout, 'currentPage');
      const projectCheck = await verifyProject(mp, config, flags, connectTimeout);
      return {
        mp,
        conn,
        mode: 'attached',
        projectRoot: config.miniprogramRoot ?? null,
        projectCheck,
      };
    } catch (err) {
      if (conn) {
        try {
          await conn.dispose();
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  };

  const launch = async () => {
    const result = await launchDevtools({
      cliPath: config.cliPath,
      projectPath: config.projectPath,
      port,
      timeoutMs: launchTimeout,
      strictVersion: Boolean(flags['strict-version']),
    });
    guardClose(result.mp);
    try {
      result.projectCheck = await verifyProject(result.mp, config, flags, connectTimeout);
      return result;
    } catch (err) {
      if (result.conn) {
        try {
          await result.conn.dispose();
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  };

  try {
    if (flags.restart) {
      // Never close the tool unless we can start it again.
      if (!config.projectPath) {
        throw new CliError(
          'up --restart needs a project path so devtools can be started again. Pass --project <dir> or set WEAPP_PROJECT.',
          { exitCode: EXIT.CONFIG, code: 'no-project' },
        );
      }
      if (!config.cliPath) {
        throw new CliError(
          'up --restart needs the devtools cli.bat so it can be started again. Pass --cli <path> or set WEAPP_CLI.',
          { exitCode: EXIT.CONFIG, code: 'no-cli' },
        );
      }
      if (await probePort(port)) {
        log('[weapp] --restart: closing the running devtools instance (explicit restart)');
        let current;
        try {
          current = await attach();
        } catch (err) {
          if (err instanceof CliError && err.code === 'project-mismatch') throw err;
          throw new CliError(
            `cannot attach to the running devtools to restart it: ${err.message}`,
            { exitCode: EXIT.UNREACHABLE, code: 'restart-failed' },
          );
        }
        if (typeof current.mp.__weappForceClose !== 'function') {
          throw new CliError('automator does not expose close(); cannot restart devtools', {
            exitCode: EXIT.UNREACHABLE,
            code: 'restart-failed',
          });
        }
        try {
          await current.mp.__weappForceClose();
        } catch (err) {
          log(`[weapp] close() reported: ${err.message}`);
        }
        const down = await waitForPortDown(port, 30_000);
        if (!down) {
          throw new CliError(
            `devtools port ${port} is still listening after close(); close it manually or use a different --port`,
            { exitCode: EXIT.UNREACHABLE, code: 'restart-failed' },
          );
        }
      }
      return wrap(await launch(), releaseOnce);
    }

    if (await probePort(port)) {
      try {
        return wrap(await attach(), releaseOnce);
      } catch (err) {
        log(`[weapp] attach failed: ${err.message}`);
        if (err instanceof CliError && err.code === 'project-mismatch') throw err;
        const stillListening = await probePort(port);
        if (stillListening) {
          throw new CliError(
            `port ${port} is listening but the automation handshake failed: ${err.message}. ` +
              `Check DevTools -> Settings -> Security -> Service Port, and make sure no other client is using this port.`,
            { exitCode: EXIT.UNREACHABLE, code: 'attach-failed' },
          );
        }
        if (!config.projectPath || !config.cliPath) throw err;
        log('[weapp] port closed after the failed attach; trying to launch devtools');
      }
    }

    if ([true, 'true', '1'].includes(flags['attach-only'])) {
      throw new CliError(`DevTools is not listening on ${port}; --attach-only forbids launch or restart`, {
        exitCode: EXIT.UNREACHABLE, code: 'not-running',
      });
    }
    if (!config.projectPath) {
      throw new CliError(
        'no mini program project path. Pass --project <dir>, set WEAPP_PROJECT, or run inside the project (or add .weapp.json).',
        { exitCode: EXIT.CONFIG, code: 'no-project' },
      );
    }
    if (!config.cliPath) {
      throw new CliError(
        'WeChat DevTools cli.bat not found. Pass --cli <path to cli.bat> or set WEAPP_CLI.',
        { exitCode: EXIT.CONFIG, code: 'no-cli' },
      );
    }

    return wrap(await launch(), releaseOnce);
  } catch (err) {
    releaseOnce();
    if (err instanceof CliError) throw err;
    throw new CliError(`cannot reach devtools on port ${port}: ${err.message}`, {
      exitCode: EXIT.UNREACHABLE,
      code: 'connect-failed',
    });
  }
}

/** Convenience: run fn with a session and always dispose. */
export async function withSession(config, flags, fn) {
  const session = await openSession(config, flags);
  session.evidence = createEvidence();
  session.evidenceReport = session.evidence.report;
  const command = process.argv[2] ?? 'command';
  const interaction = command === 'tap' ? 'element-tap' : command === 'tap-text' ? 'text-tap'
    : command === 'input' ? 'input' : command === 'scroll' ? 'programmatic-scroll'
    : command === 'swipe' ? 'sdk-touch-events' : command === 'eval' ? 'direct-method'
    : command === 'run' ? 'raw-sdk-untracked' : 'read-only';
  session.evidence.record(interaction, { command, source: 'cli-wrapper', phase: 'requested-not-proof-of-dispatch' });
  if (command === 'mock') session.evidence.report.dataSource = 'mocked';
  flags.__evidence = session.evidence.report;
  try {
    const device = await withTimeout(session.mp.callWxMethod('getSystemInfoSync'), 1500, 'evidence device');
    session.evidence.report.device = { platform: device?.platform ?? null, model: device?.model ?? null,
      system: device?.system ?? null, SDKVersion: device?.SDKVersion ?? null, source: 'wx.getSystemInfoSync' };
    session.evidence.report.deviceType = device?.platform === 'devtools' ? 'devtools-simulator'
      : device?.platform === 'android' ? 'android-device' : device?.platform === 'ios' ? 'ios-device' : 'unknown';
  } catch (error) { session.evidence.report.notes.push(`device unavailable: ${error.message}`); }
  session.diagnostics = createDiagnostics(session, {
    directory: typeof flags['evidence-dir'] === 'string' ? flags['evidence-dir'] : undefined,
    command: process.argv[2] ?? 'command',
    enabled: ![true, 'true', '1'].includes(flags['no-diagnostics']),
    evidence: session.evidenceReport,
  });
  flags.__diagnostics = session.diagnostics;
  try {
    const result = await fn(session);
    if (result && typeof result === 'object') {
      result.evidence = session.evidence.report;
      if (Number.isInteger(result.exitCode) && result.exitCode !== EXIT.OK && result.exitCode !== EXIT.CONFIG) {
        const diagnostics = await session.diagnostics.capture(new CliError(result.message ?? 'validation did not pass', { code: result.code ?? 'assertion-failed' }));
        result.data = { ...(result.data && typeof result.data === 'object' ? result.data : {}), diagnostics };
      }
    }
    return result;
  } catch (error) {
    const message = error?.message ?? String(error);
    const invalidSelector = /querySelector|not a valid selector|selector is empty|invalid selector/i.test(message);
    const err = error instanceof CliError ? error : new CliError(message, {
      code: error?.code ?? (invalidSelector ? 'bad-selector' : 'runtime-error'),
      exitCode: error?.exitCode ?? (invalidSelector ? EXIT.CONFIG : EXIT.RUNTIME), data: error?.data,
    });
    // Invalid input is not a runtime failure and must not collect user page data.
    if (err.exitCode !== EXIT.CONFIG) {
      const diagnostics = await session.diagnostics.capture(err);
      err.data = { ...(err.data && typeof err.data === 'object' ? err.data : {}), diagnostics, evidence: session.evidence.report };
    }
    throw err;
  } finally {
    await session.dispose();
  }
}
