import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PACKAGE, PACKAGE_ROOT } from '../src/package.mjs';
import { npmCli, runNpm, runNode } from '../src/lifecycle/npm.mjs';

if (process.platform !== 'win32') throw new Error('This acceptance script is specifically for Windows.');
const artifacts = path.join(PACKAGE_ROOT, '.artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-windows-acceptance-'));
const report = { package: PACKAGE.name, version: PACKAGE.version, platform: process.platform, node: process.version, root, checks: [], realAgents: 'separate verification required', macOS: 'not-verified' };

function record(name, detail = {}) {
  const item = { name, passed: true, ...detail };
  report.checks.push(item);
  process.stdout.write(JSON.stringify(item) + '\n');
}

function success(result, name) {
  assert.equal(result.code, 0, `${name}: ${result.stderr}\n${result.stdout}`);
  return result;
}

function resultJson(result, name) {
  success(result, name);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, `${name}: ${result.stdout}`);
  return envelope.data;
}

function testNpm(args, options) { return runNpm(args, { cwd: root, ...options }); }

const pack = success(await runNpm(['pack', '--pack-destination', artifacts, '--json']), 'pack');
const [archive] = JSON.parse(pack.stdout);
const release = path.join(artifacts, archive.filename);
const execTarball = path.join(root, archive.filename);
fs.copyFileSync(release, execTarball);
record('release tarball', { file: release, bytes: fs.statSync(release).size });

// A staging-only future release proves update hands off to the new version's
// resources. Never change the actual source package version for this fixture.
const futureDir = path.join(root, 'future-fixture');
fs.mkdirSync(futureDir);
for (const entry of archive.files) {
  const target = path.join(futureDir, entry.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(PACKAGE_ROOT, entry.path), target);
}
const futurePackage = JSON.parse(fs.readFileSync(path.join(futureDir, 'package.json'), 'utf8'));
futurePackage.version = '0.1.1';
fs.writeFileSync(path.join(futureDir, 'package.json'), JSON.stringify(futurePackage, null, 2));
const futureLockFile = path.join(futureDir, 'npm-shrinkwrap.json');
if (fs.existsSync(futureLockFile)) {
  const lock = JSON.parse(fs.readFileSync(futureLockFile, 'utf8'));
  lock.version = '0.1.1';
  lock.packages[''].version = '0.1.1';
  fs.writeFileSync(futureLockFile, JSON.stringify(lock, null, 2));
}
fs.appendFileSync(path.join(futureDir, 'skills', 'weapp-automation', 'SKILL.md'), '\nAcceptance fixture: resources from 0.1.1.\n');
// npm --prefix is not used here: npm pack accepts an explicit directory spec.
const futurePack = success(await runNpm(['pack', futureDir, '--pack-destination', root, '--json']), 'future fixture pack');
const futureFile = path.join(root, JSON.parse(futurePack.stdout)[0].filename);
const releases = new Map([[PACKAGE.version, { meta: PACKAGE, file: release }], ['0.1.1', { meta: futurePackage, file: futureFile }]]);
let registry;
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/' + PACKAGE.name) {
      const versions = {};
      for (const [version, value] of releases) {
        const bytes = fs.readFileSync(value.file);
        versions[version] = { ...value.meta, _id: `${PACKAGE.name}@${version}`, _hasShrinkwrap: true, dist: {
          tarball: `${registry}/${PACKAGE.name}/-/weapp-automation-cli-${version}.tgz`,
          integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'),
          shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
        } };
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: PACKAGE.name, 'dist-tags': { latest: '0.1.1' }, versions }));
      return;
    }
    if (pathname.startsWith('/' + PACKAGE.name + '/-/')) {
      const version = [...releases.keys()].find(value => pathname.endsWith(`-${value}.tgz`));
      if (!version) { response.writeHead(404); response.end(); return; }
      response.setHeader('content-type', 'application/octet-stream');
      response.end(fs.readFileSync(releases.get(version).file));
      return;
    }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    // Read-only public metadata proxy for normal dependencies. No incoming
    // headers or user credentials are forwarded to the upstream registry.
    const upstream = await fetch('https://registry.npmjs.org' + request.url, { signal: AbortSignal.timeout(30_000) });
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) { response.writeHead(502); response.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
registry = `http://127.0.0.1:${server.address().port}`;

function environment(name) {
  const prefix = path.join(root, name, 'npm 中文 prefix (x86) spaces');
  const user = path.join(root, name, '用户 skills');
  fs.mkdirSync(prefix, { recursive: true }); fs.mkdirSync(user, { recursive: true });
  const env = { ...process.env, npm_config_prefix: prefix, npm_config_registry: registry,
    npm_config_cache: path.join(artifacts, 'acceptance-npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false',
    WEAPP_USER_HOME: user, WEAPP_STATE_DIR: path.join(user, '.weapp-automation'),
    PATH: prefix + path.delimiter + process.env.PATH, CI: '1',
  };
  for (const key of ['DSH_HOME', 'DSH_AGENTS_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'WEAPP_VSCODE_ROOT']) delete env[key];
  const entry = path.join(prefix, 'node_modules', PACKAGE.name, 'bin', 'weapp.mjs');
  return { prefix, user, env, entry };
}

function shell(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, windowsVerbatimArguments: path.basename(command).toLowerCase() === 'cmd.exe', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

try {
  const boot = environment('bootstrap');
  const legacy = path.join(boot.user, '.agents', 'skills', 'weapp-automation');
  fs.mkdirSync(path.join(legacy, 'node_modules', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'legacy user skill');
  fs.writeFileSync(path.join(legacy, 'node_modules', 'fixture', 'index.js'), '// old runtime');
  const args = ['install', '--mode', 'shared', '--agents', 'codex,deepseek-harness,vscode-copilot,claude-code', '--conflict', 'backup', '--yes', '--json'];
  const bootResult = resultJson(await testNpm(['exec', '--yes', '--package', execTarball, '--', 'weapp', ...args], { env: boot.env, timeoutMs: 240_000 }), 'npx bootstrap');
  assert.equal(bootResult.bootstrap.installedVersion, PACKAGE.version);
  assert.equal(success(await runNode(boot.entry, ['--version'], { env: boot.env }), 'bootstrap version').stdout.trim(), PACKAGE.version);
  assert.equal(fs.existsSync(path.join(legacy, 'node_modules')), false);
  assert.ok(bootResult.backups.some(item => fs.readFileSync(path.join(item.backup, 'weapp-automation', 'SKILL.md'), 'utf8') === 'legacy user skill'));
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(boot.env.WEAPP_STATE_DIR, 'manifest.json'), 'utf8')).bindings).length, 4);
  record('npx bootstrap installs its exact version and hands off', { fixtureRegistryLatest: '0.1.1', installed: PACKAGE.version, completeLegacyBackup: true });
  const installedRequire = createRequire(boot.entry);
  const pins = { minimist: '0.2.4', 'jpeg-js': '0.4.4', debug: '4.3.4' };
  for (const [name, version] of Object.entries(pins)) assert.equal(installedRequire(`${name}/package.json`).version, version, `Published ${name} dependency must use the shrinkwrapped version`);
  record('published shrinkwrap retains compatible security fixes in global installations', { pins });

  const listed = resultJson(await runNode(boot.entry, ['skills', 'list', '--json'], { env: boot.env }), 'list');
  assert.equal(listed.healthy, true);
  assert.ok(listed.resources.every(resource => resource.status === 'healthy'));
  record('shared source, Claude Junction and four registrations', { loaded: listed.loaded, fixtureFilesystemOnly: true });

  const updated = resultJson(await runNode(boot.entry, ['update', '--yes', '--json'], { env: boot.env, timeoutMs: 240_000 }), 'update');
  assert.equal(updated.global.installed.version, '0.1.1');
  assert.match(fs.readFileSync(path.join(legacy, 'SKILL.md'), 'utf8'), /resources from 0\.1\.1/);
  assert.equal(success(await runNode(boot.entry, ['--version'], { env: boot.env }), 'updated version').stdout.trim(), '0.1.1');
  record('update executes new version and synchronizes new Skill resources', { fixtureVersion: '0.1.1' });

  const traditional = environment('traditional');
  success(await testNpm(['install', '--global', `${PACKAGE.name}@${PACKAGE.version}`, '--ignore-scripts', '--no-audit', '--no-fund'], { env: traditional.env, timeoutMs: 240_000 }), 'global registry installation');
  const traditionalRequire = createRequire(traditional.entry);
  for (const [name, version] of Object.entries(pins)) assert.equal(traditionalRequire(`${name}/package.json`).version, version);
  resultJson(await runNode(traditional.entry, ['install', '--mode', 'copy', '--agents', 'codex,deepseek-harness,vscode-copilot,claude-code', '--yes', '--json'], { env: traditional.env }), 'copy installation');
  for (const directory of ['.codex', '.dsh', '.copilot', '.claude']) assert.ok(fs.existsSync(path.join(traditional.user, directory, 'skills', 'weapp-automation', 'SKILL.md')));
  record('npm global registry install and explicit weapp install work with ignore-scripts', { copyTargets: 4 });

  const cmdShim = path.join(traditional.prefix, 'weapp.cmd');
  const cmdResult = success(await shell(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cmdShim}" --version"`], traditional.env), 'cmd shim');
  assert.equal(cmdResult.stdout.trim(), PACKAGE.version);
  const pwsh = path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  const psResult = success(await shell(fs.existsSync(pwsh) ? pwsh : 'powershell.exe', ['-NoLogo', '-NoProfile', '-File', path.join(traditional.prefix, 'weapp.ps1'), '--version'], traditional.env), 'PowerShell shim');
  assert.equal(psResult.stdout.trim(), PACKAGE.version);
  record('npm-generated cmd and PowerShell shims preserve Chinese, spaces and parentheses');

  const dryRun = resultJson(await runNode(traditional.entry, ['skills', 'uninstall', '--remove-shared', '--dry-run', '--json'], { env: traditional.env }), 'uninstall preview');
  assert.equal(dryRun.applied, false);
  success(await testNpm(['uninstall', '--global', PACKAGE.name, '--no-audit', '--no-fund'], { env: traditional.env }), 'remove global CLI');
  assert.equal(fs.existsSync(traditional.entry), false);
  resultJson(await testNpm(['exec', '--yes', '--package', execTarball, '--', 'weapp', 'skills', 'uninstall', '--remove-shared', '--yes', '--json'], { env: traditional.env, timeoutMs: 240_000 }), 'npx cleanup');
  assert.equal(fs.existsSync(traditional.entry), false);
  assert.equal(fs.existsSync(path.join(traditional.user, '.codex', 'skills', 'weapp-automation')), false);
  record('npx cleanup removes managed skills without reinstalling global CLI');

  resultJson(await runNode(boot.entry, ['skills', 'uninstall', '--remove-shared', '--yes', '--json'], { env: boot.env }), 'shared cleanup');
  assert.equal(fs.existsSync(legacy), false);
  record('explicit shared uninstall removes links and source while keeping backups');
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = { message: error.message, stack: error.stack };
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
  const file = path.join(artifacts, 'windows-acceptance.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ report: file, ok: report.ok, checks: report.checks.length }) + '\n');
}
