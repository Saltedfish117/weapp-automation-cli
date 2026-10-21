import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PACKAGE, PACKAGE_ROOT } from '../package.mjs';
import { commandPaths } from '../agents/index.mjs';
import { context, inside, samePath } from '../installer/paths.mjs';
import { SetupError, configuration } from '../installer/errors.mjs';

export function npmCli(env = process.env) {
  const candidates = [];
  if (env.npm_execpath?.endsWith('npm-cli.js')) candidates.push(env.npm_execpath);
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const command of commandPaths('npm', { env, platform: process.platform })) {
    const dir = path.dirname(command);
    candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    try {
      const resolved = fs.realpathSync(command);
      if (path.basename(resolved) === 'npm-cli.js') candidates.push(resolved);
    } catch { /* try next */ }
  }
  const found = candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  if (!found) throw configuration('Cannot find npm-cli.js. Install npm alongside Node.js, then retry.', 'npm-not-found');
  return found;
}

export function runNode(entry, args, { env = process.env, cwd = process.cwd(), timeoutMs = 180_000, log } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', exceeded = false;
    const limit = 4 * 1024 * 1024;
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > limit) { exceeded = true; child.kill(); } });
    child.stderr.on('data', chunk => { stderr += chunk; log?.(String(chunk)); if (stderr.length > limit) { exceeded = true; child.kill(); } });
    child.on('error', error => { clearTimeout(timer); reject(new SetupError(error.message, { code: 'process-failed', cause: error })); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (exceeded) reject(new SetupError('Child process output exceeded the limit.', { code: 'process-output-limit' }));
      else resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

export async function runNpm(args, options = {}) {
  return runNode(npmCli(options.env), args, options);
}

export async function globalStatus(ctx = context(), runner = runNpm) {
  const [root, prefix] = await Promise.all([
    runner(['root', '--global'], { env: ctx.env }),
    runner(['prefix', '--global'], { env: ctx.env }),
  ]);
  if (root.code !== 0 || prefix.code !== 0) throw new SetupError('Cannot inspect npm global prefix.', { code: 'npm-inspection-failed', data: { stderr: root.stderr || prefix.stderr } });
  const globalRoot = root.stdout.trim(), globalPrefix = prefix.stdout.trim();
  if (!path.isAbsolute(globalRoot) || !path.isAbsolute(globalPrefix) || /[\r\n]/.test(globalRoot + globalPrefix)) throw new SetupError('npm returned an invalid global prefix.', { code: 'bad-npm-prefix' });
  const packageRoot = path.join(globalRoot, PACKAGE.name);
  let installed = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const entry = path.resolve(packageRoot, manifest.bin?.weapp ?? '');
    if (manifest.name !== PACKAGE.name || !manifest.version || !manifest.bin?.weapp || !inside(entry, packageRoot) || !fs.statSync(entry).isFile()) {
      throw new Error('invalid package manifest or entrypoint');
    }
    installed = { version: manifest.version, packageRoot, entry };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new SetupError(`Invalid global ${PACKAGE.name} installation: ${error.message}`, { code: 'bad-global-package' });
  }
  const pathCommands = commandPaths('weapp', ctx);
  const intendedBin = ctx.platform === 'win32' ? globalPrefix : path.join(globalPrefix, 'bin');
  const persistentCommands = pathCommands.filter(command => {
    try {
      if (samePath(fs.realpathSync(command), path.join(PACKAGE_ROOT, 'bin', 'weapp.mjs'))) return false;
      if (path.basename(path.dirname(command)) === '.bin') {
        const sibling = path.resolve(path.dirname(command), '..', PACKAGE.name);
        if (samePath(fs.realpathSync(sibling), fs.realpathSync(PACKAGE_ROOT))) return false;
      }
    } catch { /* a foreign or broken shim is still a conflict */ }
    return true;
  });
  const pathConflict = persistentCommands.length > 0 && !samePath(path.dirname(persistentCommands[0]), intendedBin);
  return {
    prefix: globalPrefix, globalRoot, packageRoot, installed,
    currentIsGlobal: installed !== null && samePath(fs.realpathSync(installed.packageRoot), fs.realpathSync(PACKAGE_ROOT)),
    pathCommands, pathConflict,
    pathReady: pathCommands.some(command => samePath(path.dirname(command), intendedBin)),
    unsupportedPrefix: ctx.platform === 'win32' && /[&|<>^%]/.test(globalPrefix),
  };
}

export function validateVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw configuration('Expected an explicit semantic version.', 'bad-version');
  return version;
}

export async function ensureGlobal(ctx, before, { runner = runNpm, version = PACKAGE.version, log } = {}) {
  validateVersion(version);
  if (before.unsupportedPrefix) throw configuration('npm-generated Windows CMD shims do not support &, |, <, >, ^ or % in the global prefix. Choose a compatible npm prefix, then retry.', 'unsupported-npm-prefix', { prefix: before.prefix });
  if (before.pathConflict) throw configuration('A different weapp command comes first on PATH. Resolve the conflict before installation.', 'path-conflict', { paths: before.pathCommands, expectedPrefix: before.prefix });
  if (before.installed?.version !== version) {
    const installed = await runner(['install', '--global', `${PACKAGE.name}@${version}`, '--no-audit', '--no-fund', '--loglevel=error'], { env: ctx.env, log });
    if (installed.code !== 0) throw new SetupError(`npm global installation failed: ${installed.stderr || installed.stdout}`, { code: 'npm-install-failed', data: { prefix: before.prefix, version } });
  }
  const after = await globalStatus(ctx, runner);
  if (after.installed?.version !== version) throw new SetupError('Global package verification failed after npm install.', { code: 'global-verification-failed' });
  return after;
}

export async function handoff(entry, args, ctx) {
  const env = { ...ctx.env };
  // npm exec prepends its temporary .bin directory. Do not let that directory
  // shadow the verified global command after handing control to the global CLI.
  if (path.basename(path.dirname(PACKAGE_ROOT)) === 'node_modules') {
    const temporaryBin = path.join(path.dirname(PACKAGE_ROOT), '.bin');
    const pathName = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
    const value = env[pathName] ?? '';
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env[pathName] = value.split(path.delimiter).filter(directory => !samePath(directory, temporaryBin)).join(path.delimiter);
  }
  const result = await runNode(entry, [...args, '--json'], { env, timeoutMs: 600_000 });
  let envelope;
  try { envelope = JSON.parse(result.stdout); }
  catch { throw new SetupError('Global CLI did not produce a JSON result.', { code: 'handoff-failed', data: { stderr: result.stderr } }); }
  if (result.code !== 0) throw new SetupError(envelope.error?.message ?? 'Global command failed.', { code: envelope.error?.code ?? 'handoff-failed', exitCode: result.code, data: envelope.data ?? envelope.error?.data });
  return envelope.data;
}
