import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { context } from '../src/installer/paths.mjs';
import { globalStatus, ensureGlobal, handoff } from '../src/lifecycle/npm.mjs';
import { PACKAGE } from '../src/package.mjs';

const CLI = fileURLToPath(new URL('../bin/weapp.mjs', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-lifecycle-'));
  const userHome = path.join(root, 'user');
  fs.mkdirSync(userHome);
  const env = { ...process.env, WEAPP_USER_HOME: userHome, WEAPP_STATE_DIR: path.join(userHome, '.weapp-automation'), CI: '1' };
  delete env.DSH_HOME; delete env.DSH_AGENTS_HOME; delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('weapp-lifecycle-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, userHome, env, run(args) {
    const result = spawnSync(process.execPath, [CLI, ...args], { env, cwd: root, encoding: 'utf8', timeout: 40_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return { ...result, json: result.stdout.trim().startsWith('{') ? JSON.parse(result.stdout) : null };
  } };
}

test('version and lifecycle help do not start installation', t => {
  const f = fixture(t);
  assert.equal(f.run(['--version']).stdout.trim(), PACKAGE.version);
  const help = f.run(['install', '--help', '--json']);
  assert.equal(help.status, 0);
  assert.match(help.json.data.help, /deepseek-harness/);
  assert.equal(f.run(['skills', '--help', '--json']).status, 0);
  assert.equal(fs.existsSync(f.env.WEAPP_STATE_DIR), false);
});

test('skills list is one JSON envelope and read-only when nothing is registered', t => {
  const f = fixture(t);
  const result = f.run(['skills', 'list', '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.data.agents.length, 4);
  assert.equal(result.json.data.bindings.length, 0);
  assert.equal(fs.existsSync(f.env.WEAPP_STATE_DIR), false);
});

test('install dry-run reports all targets without creating state, agents or backups', t => {
  const f = fixture(t);
  const result = f.run(['install', '--mode', 'shared', '--agents', 'codex,claude-code', '--dry-run', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.json.data.operations.length, 2);
  assert.equal(result.json.data.dryRun, true);
  assert.equal(fs.existsSync(path.join(f.userHome, '.agents')), false);
  assert.equal(fs.existsSync(f.env.WEAPP_STATE_DIR), false);
});

test('no-TTY writes require confirmation and never silently select detected agents', t => {
  const f = fixture(t);
  const result = f.run(['install', '--mode', 'copy', '--agents', 'codex', '--json']);
  assert.equal(result.status, 4);
  assert.equal(result.json.error.code, 'confirmation-required');
  assert.equal(fs.existsSync(f.env.WEAPP_STATE_DIR), false);
  const noTargets = f.run(['install', '--mode', 'shared', '--yes', '--json']);
  assert.equal(noTargets.status, 4);
  assert.equal(noTargets.json.error.code, 'missing-agents');
  assert.equal(fs.existsSync(f.env.WEAPP_STATE_DIR), false);
});

test('unknown lifecycle options and agent ids are rejected', t => {
  const f = fixture(t);
  for (const args of [['skills', 'unknown', '--json'], ['skills', 'list', '--yes', '--json'], ['install', '--mode', 'shared', '--agents', 'other', '--dry-run', '--json']]) {
    const result = f.run(args);
    assert.equal(result.status, 4);
    assert.equal(result.json.ok, false);
  }
});

test('JSON flag and EOF never open an interactive prompt', t => {
  const f = fixture(t);
  const result = f.run(['install', '--json']);
  assert.equal(result.status, 4);
  assert.equal(result.json.error.code, 'missing-mode');
  assert.equal(fs.existsSync(f.env.WEAPP_STATE_DIR), false);
});

test('invalid state root is a JSON configuration error before writes', t => {
  const f = fixture(t);
  f.env.WEAPP_STATE_DIR = f.userHome;
  const result = f.run(['skills', 'list', '--json']);
  assert.equal(result.status, 4);
  assert.equal(result.json.error.code, 'unsafe-path');
});

test('bootstrap resolves and verifies an exact version, including prefixes with spaces', async t => {
  const f = fixture(t);
  const prefix = path.join(f.root, 'npm 全局 prefix');
  const globalRoot = path.join(prefix, 'node_modules');
  const packageRoot = path.join(globalRoot, PACKAGE.name);
  const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const calls = [];
  const ctx = context({ homeDir: f.userHome, env: { PATH: binDir } });
  const runner = async args => {
    calls.push(args);
    if (args[0] === 'root') return { code: 0, stdout: globalRoot + '\n', stderr: '' };
    if (args[0] === 'prefix') return { code: 0, stdout: prefix + '\n', stderr: '' };
    if (args[0] === 'install') {
      assert.equal(args[2], `${PACKAGE.name}@${PACKAGE.version}`);
      fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: PACKAGE.name, version: PACKAGE.version, bin: { weapp: 'bin/weapp.mjs' } }));
      fs.writeFileSync(path.join(packageRoot, 'bin', 'weapp.mjs'), '// fixture');
      fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'weapp.cmd' : 'weapp'), '// fixture');
      return { code: 0, stdout: '', stderr: '' };
    }
    assert.fail('unexpected npm command');
  };
  const before = await globalStatus(ctx, runner);
  assert.equal(before.installed, null);
  const after = await ensureGlobal(ctx, before, { runner });
  assert.equal(after.installed.version, PACKAGE.version);
  assert.equal(after.pathReady, true);
  await ensureGlobal(ctx, after, { runner });
  assert.equal(calls.filter(args => args[0] === 'install').length, 1);
});

test('a conflicting PATH command blocks bootstrap before npm mutation', async t => {
  const f = fixture(t);
  let invoked = false;
  await assert.rejects(ensureGlobal(context({ homeDir: f.userHome }), { pathConflict: true, pathCommands: ['other/weapp'], prefix: 'expected' }, { runner() { invoked = true; } }), error => error.code === 'path-conflict');
  assert.equal(invoked, false);
});

test('unsupported Windows npm shim prefix is rejected before package or skill mutation', async t => {
  const f = fixture(t);
  let invoked = false;
  await assert.rejects(ensureGlobal(context({ homeDir: f.userHome }), { unsupportedPrefix: true, prefix: 'prefix & special' }, { runner() { invoked = true; } }), error => error.code === 'unsupported-npm-prefix');
  assert.equal(invoked, false);
});

test('handoff uses the exact Node entrypoint and preserves structured failures', async t => {
  const f = fixture(t);
  const entry = path.join(f.root, 'child with spaces.mjs');
  fs.writeFileSync(entry, `process.stdout.write(JSON.stringify({ok:false,error:{code:'skill-conflict',message:'fixture'},data:{cliUpdated:true}}));process.exitCode=4;`);
  await assert.rejects(handoff(entry, ['skills', 'sync'], context({ homeDir: f.userHome, env: f.env })), error => error.code === 'skill-conflict' && error.exitCode === 4 && error.data.cliUpdated);
});
