import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CliError, EXIT, sanitize, sanitizeWithMeta, prepareEnvelope,
} from '../src/runtime/lib/output.mjs';

const unlimited = { maxArrayLength: Infinity, maxDepth: Infinity };
const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const marker = (value, type) => assert.equal(value.$type, type);

async function temporaryDirectory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weapp-output-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function chain(depth) {
  let value = { leaf: 'complete' };
  for (let i = 0; i < depth; i++) value = { next: value };
  return value;
}

test('ordinary JSON payloads remain compatible and the input is not mutated', () => {
  const input = { array: [1, '汉字', true, null], nested: { n: 3 } };
  const before = structuredClone(input);
  assert.deepEqual(sanitize(input), before);
  assert.deepEqual(input, before);
  assert.notEqual(sanitize(input).nested, input.nested);
});

test('arrays above 300 retain an inline count/path/reason marker', () => {
  const input = Array.from({ length: 401 }, (_, i) => i);
  const { value, serialization } = sanitizeWithMeta(input);
  assert.equal(value.length, 301);
  assert.deepEqual(value.slice(0, 300), input.slice(0, 300));
  assert.deepEqual(value[300], {
    $type: 'Truncated', path: '$', reason: 'max-array-length', kind: 'Array',
    originalCount: 401, retainedCount: 300,
  });
  assert.equal(serialization.truncated, true);
  assert.equal(serialization.truncationCount, 1);
  assert.deepEqual(serialization.truncations[0], {
    path: '$', reason: 'max-array-length', kind: 'Array', originalCount: 401, retainedCount: 300,
  });
  assert.equal(input.length, 401);
  assert.deepEqual(roundTrip(value), value);
});

test('deep containers carry explicit original counts and an escaped path', () => {
  const input = { 'a.b': { 'x"y': { leaf: [1, 2, 3] } } };
  const { value, serialization } = sanitizeWithMeta(input, { maxDepth: 1 });
  const truncated = value['a.b']['x"y'];
  marker(truncated, 'Truncated');
  assert.deepEqual(serialization.truncations, [{
    path: '$["a.b"]["x\\"y"]', reason: 'max-depth', kind: 'Object',
    originalCount: 1, retainedCount: 0,
  }]);
  assert.equal(truncated.path, serialization.truncations[0].path);
  assert.equal(sanitize(chain(8)).next.next.next.next.next.next.next.$type, 'Truncated');
});

test('custom zero limits and unlimited options are explicit', () => {
  const { value, serialization } = sanitizeWithMeta({ items: [1, 2] }, { maxArrayLength: 0 });
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].retainedCount, 0);
  assert.equal(serialization.truncations[0].originalCount, 2);
  const input = { items: Array.from({ length: 410 }, (_, i) => i), deep: chain(410) };
  const copy = sanitize(input, unlimited);
  assert.equal(copy.items.length, 410);
  let deep = copy.deep;
  for (let i = 0; i < 410; i++) deep = deep.next;
  assert.equal(deep.leaf, 'complete');
  const full = sanitizeWithMeta(input, unlimited);
  assert.equal(full.serialization.truncated, false);
  assert.deepEqual(full.serialization.limits, { maxArrayLength: null, maxDepth: null });
  assert.equal(sanitize({ x: {} }, 6).x.$type, 'Truncated');
});

test('shared references are expanded; only actual ancestors are circular', () => {
  const shared = { answer: 42 };
  const input = { left: shared, right: shared };
  const { value, serialization } = sanitizeWithMeta(input);
  assert.deepEqual(value, { left: { answer: 42 }, right: { answer: 42 } });
  assert.equal(serialization.cycleCount, 0);
  input.self = input;
  shared.parent = input;
  const cyclic = sanitizeWithMeta(input, unlimited);
  assert.deepEqual(cyclic.value.self, { $type: 'Circular', path: '$.self', $ref: '$' });
  assert.equal(cyclic.value.left.parent.$ref, '$');
  assert.equal(cyclic.value.right.parent.$ref, '$');
  assert.equal(cyclic.serialization.cycleCount, 3);
  assert.deepEqual(roundTrip(cyclic.value), cyclic.value);
});

test('arrays, Maps and Sets correctly mark cycles without losing Map key types', () => {
  const array = [];
  array.push(array);
  const map = new Map([[1, 'number key'], ['1', 'string key']]);
  map.set(map, map);
  const set = new Set();
  set.add(set);
  const value = sanitize({ array, map, set }, unlimited);
  assert.equal(value.array[0].$ref, '$.array');
  assert.deepEqual(value.map.entries.slice(0, 2), [[1, 'number key'], ['1', 'string key']]);
  assert.equal(value.map.entries[2][0].$ref, '$.map');
  assert.equal(value.map.entries[2][1].$ref, '$.map');
  assert.equal(value.set.values[0].$ref, '$.set');
});

test('BigInt, Dates, RegExp, bytes, functions and non-JSON primitives are JSON-safe', () => {
  function example() {}
  const sparse = new Array(2);
  sparse[1] = undefined;
  const input = {
    bigint: 9007199254740993n, date: new Date('2026-01-02T03:04:05.000Z'),
    invalidDate: new Date(NaN), regexp: /hello/gi, buffer: Buffer.from([0, 255, 3]),
    fn: example, undefined, nan: NaN, positiveInfinity: Infinity,
    negativeInfinity: -Infinity, negativeZero: -0, symbol: Symbol.for('test'), sparse,
    typed: new BigInt64Array([1n, 2n]), bytes: Uint8Array.from([5, 6]).buffer,
    view: new DataView(Uint8Array.from([7, 8]).buffer),
  };
  const value = sanitize(input, unlimited);
  assert.deepEqual(value.bigint, { $type: 'BigInt', value: '9007199254740993' });
  assert.equal(value.date.value, '2026-01-02T03:04:05.000Z');
  assert.equal(value.invalidDate.value, 'Invalid Date');
  assert.equal(value.regexp.value, '/hello/gi');
  assert.equal(value.fn.name, 'example');
  assert.equal(value.undefined.$type, 'Undefined');
  assert.equal(value.nan.value, 'NaN');
  assert.equal(value.positiveInfinity.value, 'Infinity');
  assert.equal(value.negativeInfinity.value, '-Infinity');
  assert.equal(value.negativeZero.value, '-0');
  assert.equal(value.symbol.key, 'test');
  assert.equal(value.sparse[0].$type, 'ArrayHole');
  assert.equal(value.sparse[1].$type, 'Undefined');
  assert.equal(value.typed.values[1].value, '2');
  assert.equal(value.buffer.byteLength, 3);
  assert.deepEqual([...Buffer.from(value.buffer.data, 'base64')], [0, 255, 3]);
  assert.deepEqual([...Buffer.from(value.bytes.data, 'base64')], [5, 6]);
  assert.deepEqual([...Buffer.from(value.view.data, 'base64')], [7, 8]);
  assert.deepEqual(roundTrip(value), value);
});

test('Maps, Sets, Buffers and typed arrays report original and retained lengths', () => {
  const input = {
    map: new Map([[1, 2], [3, 4], [5, 6]]), set: new Set([1, 2, 3]),
    buffer: Buffer.from([1, 2, 3]), typed: new Uint16Array([1, 2, 3]),
  };
  const { value, serialization } = sanitizeWithMeta(input, { maxArrayLength: 2 });
  assert.equal(value.map.entries.length, 2);
  assert.equal(value.set.values.length, 2);
  assert.equal(value.buffer.byteLength, 3);
  assert.equal(Buffer.from(value.buffer.data, 'base64').length, 2);
  assert.equal(value.typed.values.length, 3);
  assert.equal(serialization.truncationCount, 4);
  for (const entry of serialization.truncations) {
    assert.equal(entry.originalCount, 3);
    assert.equal(entry.retainedCount, 2);
    assert.equal(entry.reason, 'max-array-length');
  }
});

test('getters and toJSON are not invoked, function-valued properties are not omitted', () => {
  let calls = 0;
  const input = { toJSON() { calls++; throw new Error('must not run'); } };
  Object.defineProperty(input, 'bad', { enumerable: true, get() { calls++; throw new Error('getter'); } });
  const copy = sanitize(input);
  assert.equal(copy.toJSON.$type, 'Function');
  assert.equal(copy.bad.$type, 'Accessor');
  assert.deepEqual(roundTrip(copy), copy);
  assert.equal(calls, 0);
});

test('literal __proto__ keys, enumerable symbols and Error causes survive safely', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
  const copy = sanitize(input);
  assert.equal(Object.hasOwn(copy, '__proto__'), true);
  assert.equal(copy.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(roundTrip(copy), copy);
  const symbolic = { name: 'value', [Symbol('hidden-key')]: 42 };
  const symbols = sanitize(symbolic);
  assert.equal(symbols.properties.name, 'value');
  assert.equal(symbols.symbolProperties[0].value, 42);
  const error = new Error('outer', { cause: new Error('inner') });
  const safeError = sanitize(error, unlimited);
  assert.equal(safeError.properties.message, 'outer');
  assert.equal(safeError.properties.cause.properties.message, 'inner');
});

test('prepareEnvelope adds bounded serialization metadata without truncating it', async () => {
  const data = Object.fromEntries(Array.from({ length: 425 }, (_, i) => [`list${i}`, [1, 2, 3]]));
  const input = { ok: true, cmd: 'test', data, meta: { port: 9420 } };
  const envelope = await prepareEnvelope(input, { maxArrayLength: 1 });
  const serialization = envelope.meta.serialization;
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.port, 9420);
  assert.equal(serialization.truncationCount, 425);
  assert.equal(serialization.truncations.length, 425);
  assert.equal(serialization.truncations[424].path, '$.data.list424');
  assert.equal(serialization.truncations[424].originalCount, 3);
  assert.equal(serialization.truncations[424].retainedCount, 1);
  assert.deepEqual(roundTrip(envelope), envelope);
  assert.equal(input.meta.serialization, undefined);
});

test('metadata remains readable when the requested maxDepth is zero', async () => {
  const envelope = await prepareEnvelope({ ok: true, data: { nested: {} }, meta: {} }, { maxDepth: 0 });
  assert.equal(envelope.meta.serialization.truncated, true);
  assert.equal(envelope.meta.serialization.truncationCount, 2);
  assert.equal(envelope.meta.serialization.truncations[0].path, '$.data');
});

test('resultOut writes a complete JSON-safe envelope, with no array/depth truncation', async (t) => {
  const dir = await temporaryDirectory(t);
  const target = path.join(dir, 'complete 汉字.json');
  const shared = { big: 123n };
  const payload = {
    ok: true, cmd: 'export', meta: { port: 9420 },
    data: { items: Array.from({ length: 501 }, (_, i) => i), deep: chain(18), left: shared, right: shared },
  };
  payload.data.self = payload.data;
  const envelope = await prepareEnvelope(payload, { resultOut: target });
  assert.equal(envelope.meta.serialization.truncated, true);
  assert.equal(envelope.data.items.length, 301);
  assert.deepEqual(envelope.meta.serialization.resultOut, { path: target, written: true, complete: true });
  const full = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(full.meta.serialization.truncated, false);
  assert.equal(full.meta.serialization.truncationCount, 0);
  assert.equal(full.meta.serialization.cycleCount, 1);
  assert.deepEqual(full.meta.serialization.limits, { maxArrayLength: null, maxDepth: null });
  assert.equal(full.data.items.length, 501);
  assert.equal(full.data.items[500], 500);
  let deep = full.data.deep;
  for (let i = 0; i < 18; i++) deep = deep.next;
  assert.equal(deep.leaf, 'complete');
  assert.equal(full.data.self.$ref, '$.data');
  assert.deepEqual(full.data.left, full.data.right);
  assert.equal(full.data.left.big.value, '123');
  assert.equal(full.meta.serialization.resultOut.path, target);
  assert.deepEqual(await fs.readdir(dir), [path.basename(target)]);
  assert.equal(payload.data.items.length, 501);
});

test('resultOut atomically replaces only the explicitly requested destination', async (t) => {
  const dir = await temporaryDirectory(t);
  const target = path.join(dir, 'existing.json');
  await fs.writeFile(target, 'original sentinel', 'utf8');
  await prepareEnvelope({ ok: true, data: [1, 2, 3] }, { resultOut: target, maxArrayLength: 1 });
  const full = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.deepEqual(full.data, [1, 2, 3]);
  assert.deepEqual(await fs.readdir(dir), ['existing.json']);
});

test('resultOut failure is an explicit CliError and cleans its temporary sibling', async (t) => {
  const dir = await temporaryDirectory(t);
  const target = path.join(dir, 'occupied');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'sentinel'), 'keep');
  await assert.rejects(
    prepareEnvelope({ ok: true, data: [1, 2] }, { resultOut: target }),
    (error) => error instanceof CliError && error.code === 'result-out-failed'
      && error.exitCode === EXIT.RUNTIME && error.data.resultOut === target
      && typeof error.data.causeCode === 'string',
  );
  assert.equal(await fs.readFile(path.join(target, 'sentinel'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(dir), ['occupied']);
  const missing = path.join(dir, 'missing', 'out.json');
  await assert.rejects(prepareEnvelope({ ok: true }, { resultOut: missing }), {
    code: 'result-out-failed', exitCode: EXIT.RUNTIME,
  });
  assert.deepEqual(await fs.readdir(dir), ['occupied']);
});

test('invalid limits and resultOut values reject with configuration errors', async () => {
  for (const bad of [-1, NaN, 1.5, '300', true]) {
    assert.throws(() => sanitize({}, { maxArrayLength: bad }), { code: 'bad-serialization-limit', exitCode: 4 });
    assert.throws(() => sanitize({}, { maxDepth: bad }), { code: 'bad-serialization-limit', exitCode: 4 });
  }
  for (const resultOut of ['', '   ', true, null, 'x\0y']) {
    await assert.rejects(prepareEnvelope({ ok: true }, { resultOut }), { code: 'bad-result-out', exitCode: 4 });
  }
  await assert.rejects(prepareEnvelope(null), { code: 'bad-output-envelope', exitCode: 4 });
});

test('emitAsync flushes a large multilingual envelope before immediate process.exit', () => {
  const moduleUrl = new URL('../src/runtime/lib/output.mjs', import.meta.url).href;
  const script = `import { emitAsync } from ${JSON.stringify(moduleUrl)};
await emitAsync({ok:true,data:'中文😀'.repeat(200000)});
process.exit(0);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.data.length, '中文😀'.length * 200000);
  assert.equal(result.stderr, '');
});
