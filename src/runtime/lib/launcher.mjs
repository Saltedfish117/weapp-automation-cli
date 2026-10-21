/**
 * Start WeChat DevTools and attach to its automation port.
 *
 * Why not automator.launch()?
 *   miniprogram-automator 0.13.0 spawns cli.bat directly. On Node >= 20.12
 *   (tested on v22.18.0) child_process.spawn() refuses to execute .bat/.cmd
 *   without a shell and throws EINVAL synchronously. This launcher runs the
 *   batch file through cmd.exe instead, preserving argument quoting.
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { CliError, EXIT, log, withTimeout } from './output.mjs';
import { resolveMiniprogramRoot } from './config.mjs';
import { loadAutomator, probePort } from './lock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function quoteCmdArg(value) {
  const text = String(value);
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {{cliPath:string, projectPath:string, port:number, timeoutMs?:number, strictVersion?:boolean}} options
 * @returns {Promise<{mp:any, conn:any, mode:'launched', cliOutput:string}>}
 */
export async function launchDevtools({
  cliPath,
  projectPath,
  port,
  timeoutMs = 180_000,
  strictVersion = false,
}) {
  if (!cliPath) {
    throw new CliError('WeChat DevTools cli.bat not found. Pass --cli <path to cli.bat> or set WEAPP_CLI.', {
      exitCode: EXIT.CONFIG,
      code: 'no-cli',
    });
  }
  if (!isFile(cliPath)) {
    throw new CliError(`devtools cli does not exist: ${cliPath}`, {
      exitCode: EXIT.CONFIG,
      code: 'no-cli',
    });
  }
  if (!projectPath) {
    throw new CliError('no mini program project path. Pass --project <dir>, set WEAPP_PROJECT, or add .weapp.json.', {
      exitCode: EXIT.CONFIG,
      code: 'no-project',
    });
  }
  if (!isDirectory(projectPath)) {
    throw new CliError(`project path is not a directory: ${projectPath}`, {
      exitCode: EXIT.CONFIG,
      code: 'no-project',
    });
  }
  const projectRoot = resolveMiniprogramRoot(projectPath);
  if (!projectRoot) {
    throw new CliError(
      `no app.json under ${projectPath}. --project must point to the compiled miniprogram root ` +
        `(for uni-app: unpackage/dist/dev/mp-weixin), not the source root.`,
      { exitCode: EXIT.CONFIG, code: 'no-app-json' },
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliError(`invalid launch timeout: ${timeoutMs}`, {
      exitCode: EXIT.CONFIG,
      code: 'bad-launch-timeout',
    });
  }
  if (await probePort(port)) {
    throw new CliError(
      `port ${port} is already in use. Attach to the running devtools instead, or pass --restart to close it first.`,
      { exitCode: EXIT.UNREACHABLE, code: 'port-busy' },
    );
  }

  const { Connection, MiniProgram } = loadAutomator();
  if (!strictVersion) MiniProgram.prototype.checkVersion = async () => {};

  const cliArgs = ['auto', '--project', projectRoot, '--auto-port', String(port)];
  let child;
  let childError = null;
  let output = '';

  const append = (chunk) => {
    output = (output + String(chunk)).slice(-8000);
  };

  try {
    if (/\.(bat|cmd)$/i.test(cliPath)) {
      // cmd.exe /s /c ""C:\path with space\cli.bat" auto --project "D:\x y" ..."
      // The outer quote pair is required by cmd /s /c when the command itself
      // is quoted. windowsVerbatimArguments keeps Node from re-quoting it.
      const command = `""${cliPath}" ${cliArgs.map(quoteCmdArg).join(' ')}"`;
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
        windowsVerbatimArguments: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      child = spawn(cliPath, cliArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  } catch (err) {
    throw new CliError(`cannot start devtools cli: ${err.message}`, {
      exitCode: EXIT.UNREACHABLE,
      code: 'launch-failed',
    });
  }

  child.on('error', (err) => {
    childError = err;
  });
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  log(`[weapp] launching devtools for ${projectRoot} on port ${port}`);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (childError) {
      throw new CliError(
        `failed to start devtools cli: ${childError.message}${output.trim() ? `\ncli output:\n${output.trim()}` : ''}`,
        { exitCode: EXIT.UNREACHABLE, code: 'launch-failed' },
      );
    }

    let conn = null;
    try {
      conn = await withTimeout(
        Connection.create(`ws://127.0.0.1:${port}`),
        Math.min(5000, Math.max(1000, deadline - Date.now())),
        `connect ws://127.0.0.1:${port}`,
      );
      const mp = new MiniProgram(conn);
      if (strictVersion) {
        await withTimeout(mp.checkVersion(), 5000, 'checkVersion');
      }
      // Round-trip once so we don't return a socket the app cannot serve.
      await withTimeout(mp.currentPage(), 5000, 'currentPage');
      await sleep(800);
      return { mp, conn, mode: 'launched', cliOutput: output.trim(), projectRoot };
    } catch (err) {
      lastError = err;
      if (conn) {
        try {
          await conn.dispose();
        } catch {
          /* ignore */
        }
      }
      await sleep(500);
    }
  }

  const detail = output.trim() ? `\ncli output:\n${output.trim()}` : '';
  throw new CliError(
    `devtools did not expose automation port ${port} within ${timeoutMs}ms` +
      `${lastError ? ` (last error: ${lastError.message})` : ''}. ` +
      `Check that DevTools can open the project and that Settings -> Security -> Service Port is enabled.${detail}`,
    { exitCode: EXIT.UNREACHABLE, code: 'launch-timeout' },
  );
}

/** Wait until the automation port stops listening (used by `up --restart`). */
export async function waitForPortDown(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probePort(port))) return true;
    await sleep(250);
  }
  return false;
}
