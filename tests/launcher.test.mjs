import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchDevtools } from '../src/runtime/lib/launcher.mjs';

const isWindows = process.platform === 'win32';

test('launcher preserves Unicode project paths through cli.bat', { skip: !isWindows }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '微信 测试 (x86) '));
  fs.writeFileSync(path.join(root, 'app.json'), '{}', 'utf8');
  const bat = path.join(root, 'cli 中文.bat');
  const argsJs = path.join(root, 'args.js');
  const out = path.join(root, 'args.json');
  fs.writeFileSync(
    argsJs,
    `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`,
    'utf8',
  );
  fs.writeFileSync(bat, `@echo off\r\n"${process.execPath}" "%~dp0args.js" %*\r\n`, 'ascii');

  try {
    await assert.rejects(
      launchDevtools({
        cliPath: bat,
        projectPath: root,
        port: 19778,
        timeoutMs: 1200,
      }),
      (err) => err.code === 'launch-timeout' && err.exitCode === 3,
    );
    assert.equal(fs.existsSync(out), true);
    const args = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(args, ['auto', '--project', root, '--auto-port', '19778']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
