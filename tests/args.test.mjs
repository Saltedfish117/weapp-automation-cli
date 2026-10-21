import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'bin', 'weapp.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-args-'));

function run(args) {
  const env = { ...process.env };
  delete env.WEAPP_PORT;
  delete env.WEAPP_PROJECT;
  delete env.WEAPP_CLI;
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: tmp,
    env,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
  });
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(result.stdout);
  } catch (err) {
    parseError = err.message;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json, parseError };
}

test('help is one parseable JSON envelope', () => {
  const r = run(['help']);
  assert.equal(r.status, 0);
  assert.equal(r.parseError, null);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.cmd, 'help');
});

test('help still works when the port is invalid', () => {
  const r = run(['help', '--port', '70000']);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
});

test('invalid port is a config error, not a silent fallback', () => {
  const r = run(['up', '--port', '70000']);
  assert.equal(r.status, 4);
  assert.equal(r.json.error.code, 'bad-port');
});

test('port flag without a value is rejected', () => {
  const r = run(['up', '--port']);
  assert.equal(r.status, 4);
  assert.equal(r.json.error.code, 'bad-port');
});

test('unknown flags are rejected', () => {
  const r = run(['help', '--nope']);
  assert.equal(r.status, 4);
  assert.equal(r.json.error.code, 'unknown-flag');
});

test('out-of-range numbers are rejected before connecting', () => {
  const limit = run(['find-all', '.x', '--limit', '-1']);
  assert.equal(limit.status, 4);
  assert.equal(limit.json.error.code, 'bad-number');

  const threshold = run(['shot', '--threshold', '-1']);
  assert.equal(threshold.status, 4);
  assert.equal(threshold.json.error.code, 'bad-number');

  const index = run(['input', 'input', '--index', '-1', '--value', 'x']);
  assert.equal(index.status, 4);
  assert.equal(index.json.error.code, 'bad-number');

  const tapGone = run(['tap', 'view', '--wait-gone']);
  assert.equal(tapGone.status, 4);
  assert.equal(tapGone.json.error.code, 'missing-arg');
});

test('missing script is a config error', () => {
  const r = run(['run', 'definitely-missing-script.mjs']);
  assert.equal(r.status, 4);
  assert.equal(r.json.error.code, 'no-script');
});

test('lock status uses the resolved port in both data and meta', () => {
  const r = run(['lock', 'status', '--port', '9603']);
  assert.equal(r.status, 0);
  assert.equal(r.json.data.port, 9603);
  assert.equal(r.json.meta.port, 9603);
  assert.match(r.json.data.file, /weapp-automation-9603\.lock$/);
});

test('--value requires an explicit value', () => {
  const r = run(['input', 'view', '--value']);
  assert.equal(r.status, 4);
  assert.equal(r.json.error.code, 'missing-flag-value');
});

test('navigation commands require a target before connecting', () => {
  for (const cmd of ['navigate', 'redirect', 'switch-tab']) {
    const r = run([cmd]);
    assert.equal(r.status, 4, cmd);
    assert.equal(r.json.error.code, 'missing-arg', cmd);
  }
});

test('text and wait commands validate arguments before connecting', () => {
  for (const cmd of ['find-text', 'tap-text', 'wait-for']) {
    const r = run([cmd]);
    assert.equal(r.status, 4, cmd);
    assert.equal(r.json.error.code, 'missing-arg', cmd);
  }
  const wait = run(['wait-for', 'view', '--wait-timeout', '-1']);
  assert.equal(wait.status, 4);
  assert.equal(wait.json.error.code, 'bad-number');
});

test('validation specs and source output targets are rejected before connecting', () => {
  for (const cmd of ['assert-nodes', 'ready', 'swipe']) {
    const r = run(cmd === 'swipe' ? [cmd, '.list'] : [cmd]);
    assert.equal(r.status, 4, cmd);
    assert.equal(r.json.error.code, 'missing-arg', cmd);
  }
  const spec = path.join(tmp, 'bad-ready.json');
  fs.writeFileSync(spec, JSON.stringify({ conditions: [{ type: 'layout' }] }));
  const bad = run(['ready', '--spec', '@' + spec]);
  assert.equal(bad.status, 4);
  const conflict = run(['up', '--attach-only', '--restart']);
  assert.equal(conflict.status, 4);
  assert.equal(conflict.json.error.code, 'conflicting-flags');
  const beforeSource = fs.readFileSync(CLI, 'utf8');
  const sourceOut = run(['help', '--result-out', CLI]);
  assert.equal(sourceOut.status, 4);
  assert.equal(sourceOut.json.error.code, 'bad-output-path');
  assert.equal(fs.readFileSync(CLI, 'utf8'), beforeSource, 'source must never be overwritten even by an error envelope');
});

test('result-out exports a complete help envelope', () => {
  const out = path.join(tmp, 'help-complete.json');
  const r = run(['help', '--result-out', out]);
  assert.equal(r.status, 0);
  assert.equal(r.json.meta.serialization.resultOut.complete, true);
  const full = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(full.meta.serialization.limits.maxDepth, null);
  assert.equal(full.data.commands['assert-nodes'].startsWith('assert-nodes'), true);
});

test('unknown command still emits the full envelope', () => {
  const r = run(['definitely-not-a-command']);
  assert.equal(r.status, 4);
  assert.equal(r.json.error.code, 'unknown-command');
  assert.ok(r.json.meta && 'port' in r.json.meta && 'durationMs' in r.json.meta);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
