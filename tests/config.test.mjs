import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, resolveMiniprogramRoot } from '../src/runtime/lib/config.mjs';

test('invalid flag port throws bad-port', () => {
  assert.throws(
    () => resolveConfig({ port: '70000' }, os.tmpdir()),
    (err) => err.code === 'bad-port' && err.exitCode === 4,
  );
});

test('empty flag port throws instead of falling back to 9420', () => {
  assert.throws(
    () => resolveConfig({ port: '' }, os.tmpdir()),
    (err) => err.code === 'bad-port' && err.exitCode === 4,
  );
});

test('boolean port flag throws bad-port', () => {
  assert.throws(
    () => resolveConfig({ port: true }, os.tmpdir()),
    (err) => err.code === 'bad-port' && err.exitCode === 4,
  );
});

test('project flag without a value throws', () => {
  assert.throws(
    () => resolveConfig({ project: true }, os.tmpdir()),
    (err) => err.code === 'missing-flag-value' && err.exitCode === 4,
  );
});

test('malformed .weapp.json is reported as a warning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-config-'));
  try {
    fs.writeFileSync(path.join(dir, '.weapp.json'), '{ not json', 'utf8');
    const config = resolveConfig({}, dir);
    assert.ok(config.warnings.some((w) => w.includes('ignoring malformed')));
    assert.equal(config.port, 9420);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a UTF-8 BOM in .weapp.json is tolerated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-config-'));
  try {
    fs.writeFileSync(path.join(dir, '.weapp.json'), '\uFEFF{"port":9599}', 'utf8');
    const config = resolveConfig({}, dir);
    assert.equal(config.port, 9599);
    assert.equal(config.sources.port, '.weapp.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveMiniprogramRoot accepts a directory containing app.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-root-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.json'), '{}', 'utf8');
    assert.equal(resolveMiniprogramRoot(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveMiniprogramRoot follows project.config.json miniprogramRoot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-root-'));
  try {
    const compiled = path.join(dir, 'dist', 'dev', 'mp-weixin');
    fs.mkdirSync(compiled, { recursive: true });
    fs.writeFileSync(path.join(compiled, 'app.json'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'project.config.json'),
      JSON.stringify({ miniprogramRoot: 'dist/dev/mp-weixin' }),
      'utf8',
    );
    assert.equal(resolveMiniprogramRoot(dir), compiled);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveMiniprogramRoot finds the uni-app compiled output from the source root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-root-'));
  try {
    fs.writeFileSync(path.join(dir, 'project.config.json'), '{}', 'utf8');
    const compiled = path.join(dir, 'unpackage', 'dist', 'dev', 'mp-weixin');
    fs.mkdirSync(compiled, { recursive: true });
    fs.writeFileSync(path.join(compiled, 'app.json'), '{}', 'utf8');
    assert.equal(resolveMiniprogramRoot(dir), compiled);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveMiniprogramRoot returns null when app.json is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-root-'));
  try {
    fs.writeFileSync(path.join(dir, 'project.config.json'), '{}', 'utf8');
    assert.equal(resolveMiniprogramRoot(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveConfig reads the appid from the project config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-root-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.json'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'project.config.json'),
      JSON.stringify({ appid: 'wx1234567890abcdef' }),
      'utf8',
    );
    const config = resolveConfig({ project: dir }, dir);
    assert.equal(config.appid, 'wx1234567890abcdef');
    assert.equal(config.miniprogramRoot, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory named project.config.json is not accepted as a project file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-config-'));
  try {
    const fake = path.join(dir, 'project.config.json');
    fs.mkdirSync(fake);
    const config = resolveConfig({}, dir);
    assert.equal(config.projectPath, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
