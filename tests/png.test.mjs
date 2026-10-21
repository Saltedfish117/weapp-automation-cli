import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import {
  cropPng,
  comparePng,
  intersectBox,
  readPng,
  maskPng,
  defaultShotPath,
} from '../src/runtime/lib/shot.mjs';

function makePng(width, height, color = [10, 20, 30]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = color[0];
    png.data[i * 4 + 1] = color[1];
    png.data[i * 4 + 2] = color[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('cropPng crops a valid box', () => {
  const source = makePng(10, 10);
  const cropped = PNG.sync.read(cropPng(source, { left: 2, top: 3, width: 4, height: 5 }));
  assert.equal(cropped.width, 4);
  assert.equal(cropped.height, 5);
});

test('cropPng rejects a box outside the screenshot instead of silently clamping', () => {
  const source = makePng(10, 10);
  assert.throws(
    () => cropPng(source, { left: -1, top: 0, width: 4, height: 4 }),
    (err) => err.code === 'bad-crop',
  );
  assert.throws(
    () => cropPng(source, { left: 8, top: 0, width: 4, height: 4 }),
    (err) => err.code === 'bad-crop',
  );
});

test('cropPng rejects a null box and negative padding', () => {
  const source = makePng(10, 10);
  assert.throws(() => cropPng(source, null), (err) => err.code === 'bad-crop');
  assert.throws(
    () => cropPng(source, { left: 0, top: 0, width: 4, height: 4 }, -1),
    (err) => err.code === 'bad-crop',
  );
});

test('intersectBox returns null for a fully offscreen element', () => {
  const viewport = { left: 0, top: 0, width: 390, height: 844 };
  assert.equal(intersectBox({ left: 0, top: 900, width: 100, height: 50 }, viewport), null);
  assert.equal(intersectBox({ left: -100, top: 10, width: 50, height: 50 }, viewport), null);
  const partial = intersectBox({ left: -10, top: 10, width: 50, height: 50 }, viewport);
  assert.deepEqual(partial, { left: 0, top: 10, width: 40, height: 50 });
});

test('comparePng reports a size mismatch', () => {
  const result = comparePng(makePng(10, 10), makePng(11, 10));
  assert.equal(result.sizeMismatch, true);
  assert.equal(result.mismatchPct, 100);
  assert.equal(result.diffBuffer, null);
});

test('comparePng reports identical images as zero mismatch', () => {
  const png = makePng(10, 10);
  const result = comparePng(png, png);
  assert.equal(result.sizeMismatch, false);
  assert.equal(result.mismatchPct, 0);
});

test('readPng turns a corrupt baseline into a config error', () => {
  assert.throws(
    () => readPng(Buffer.from('not a png'), 'baseline'),
    (err) => err.code === 'bad-png' && err.exitCode === 4,
  );
});

test('maskPng paints the requested viewport rectangle', () => {
  const source = makePng(10, 10, [255, 255, 255]);
  const masked = PNG.sync.read(
    maskPng(source, [{ left: 2, top: 3, width: 4, height: 5 }], [255, 0, 0]),
  );
  const inside = (masked.width * 3 + 2) << 2;
  const outside = (masked.width * 2 + 2) << 2;
  assert.deepEqual([...masked.data.subarray(inside, inside + 3)], [255, 0, 0]);
  assert.deepEqual([...masked.data.subarray(outside, outside + 3)], [255, 255, 255]);
});

test('maskPng leaves the buffer untouched when no boxes are given', () => {
  const source = makePng(4, 4);
  assert.equal(maskPng(source, []), source);
});

test('defaultShotPath is unique for rapid unlabeled captures', () => {
  const a = defaultShotPath('C:/tmp', 'pages/index/index');
  const b = defaultShotPath('C:/tmp', 'pages/index/index');
  assert.notEqual(a, b);
});
