import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);

test('patched minimist rejects prototype pollution while retaining normal argument parsing', () => {
  const minimist = require('minimist');
  const parsed = minimist(['--count', '3', 'fixture', '--__proto__.weappPolluted', 'yes']);
  assert.equal(parsed.count, 3);
  assert.deepEqual(parsed._, ['fixture']);
  assert.equal({}.weappPolluted, undefined);
});

test('SDK image stack retains PNG read and JPEG encode/decode after compatible fixes', async () => {
  const Jimp = require('jimp');
  const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.from(Array(4).fill([120, 160, 200, 255]).flat()) });
  const image = await Jimp.read(png);
  assert.equal(image.bitmap.width, 2);
  const jpeg = await new Promise((resolve, reject) => image.getBuffer(Jimp.MIME_JPEG, (error, buffer) => error ? reject(error) : resolve(buffer)));
  const decoded = await Jimp.read(jpeg);
  assert.equal(decoded.bitmap.width, 2);
  assert.equal(decoded.bitmap.height, 2);
  assert.equal(decoded.bitmap.data.length, 16);
});

test('legacy mkdirp and debug keep the SDK-facing APIs with patched transitives', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weapp-deps-'));
  try {
    require('mkdirp').sync(path.join(root, '中文', 'nested'));
    assert.ok(fs.statSync(path.join(root, '中文', 'nested')).isDirectory());
    const debug = require('debug')('weapp-compat');
    assert.equal(typeof debug.extend, 'function');
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('weapp-deps-'));
    fs.rmSync(root, { recursive: true });
  }
});
