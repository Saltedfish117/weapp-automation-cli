/**
 * Output contract for the weapp CLI.
 *
 * stdout: exactly one JSON envelope, always machine-parsable.
 * stderr: human/progress logs only.
 */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const EXIT = Object.freeze({
  OK: 0,
  RUNTIME: 1,
  ASSERT: 2,
  UNREACHABLE: 3,
  CONFIG: 4,
});

export class CliError extends Error {
  /**
   * @param {string} message
   * @param {{exitCode?: number, code?: string, data?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? EXIT.RUNTIME;
    this.code = options.code ?? 'error';
    this.data = options.data;
  }
}

/** Write an already prepared JSON envelope (legacy synchronous API). */
export function emit(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

/** Await the write callback before process.exit(), including large UTF-8 output. */
export function emitAsync(payload) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(payload, null, 2) + '\n';
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

export function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

const DEFAULT_MAX_ARRAY_LENGTH = 300;
const DEFAULT_MAX_DEPTH = 6;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const tag = ($type, fields = {}) => ({ $type, ...fields });
const propertyPath = (parent, key) => /^[A-Za-z_$][\w$]*$/.test(key)
  ? `${parent}.${key}`
  : `${parent}[${JSON.stringify(key)}]`;

function limitsFor(options) {
  // The old, undocumented numeric second argument was the starting depth.
  const initialDepth = typeof options === 'number' ? options : 0;
  if (typeof options === 'number') options = {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new CliError('serialization options must be an object', {
      exitCode: EXIT.CONFIG, code: 'bad-serialization-options',
    });
  }
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  for (const [name, value] of Object.entries({ maxArrayLength, maxDepth, initialDepth })) {
    if (value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) {
      throw new CliError(`${name} must be a non-negative safe integer or Infinity`, {
        exitCode: EXIT.CONFIG, code: 'bad-serialization-limit',
      });
    }
  }
  return { maxArrayLength, maxDepth, initialDepth };
}

/**
 * JSON-safe copy with explicit limits and metadata. Root depth is zero; only
 * containers beyond maxDepth are replaced. Infinity disables either limit.
 *
 * Arrays keep up to maxArrayLength original items, then ONE $type:Truncated
 * marker (the marker is not included in retainedCount). Maps/Sets retain their
 * key/value types, Buffers retain base64 bytes. Other non-JSON values use typed
 * markers. No user toJSON/getter is invoked. Only ancestors are circular:
 * repeated sibling references are copied, never incorrectly marked as cycles.
 *
 * The metadata is deliberately NOT sent through the limiter. Every truncation
 * remains visible even when there are more than 300 truncation records.
 * @returns {{value: unknown, serialization: object}}
 */
export function sanitizeWithMeta(value, options = {}) {
  const { maxArrayLength, maxDepth, initialDepth } = limitsFor(options);
  const serialization = {
    version: 1,
    format: 'weapp-json-safe',
    limits: {
      maxArrayLength: maxArrayLength === Infinity ? null : maxArrayLength,
      maxDepth: maxDepth === Infinity ? null : maxDepth,
    },
    truncated: false,
    truncationCount: 0,
    truncations: [],
    cycleCount: 0,
    cycles: [],
  };
  const ancestors = new Map();

  function truncation(at, reason, kind, originalCount, retainedCount) {
    const record = { path: at, reason, kind, originalCount, retainedCount };
    serialization.truncated = true;
    serialization.truncationCount++;
    serialization.truncations.push(record);
    return tag('Truncated', record);
  }

  function property(object, key, depth, at) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return tag('Unavailable', { path: at, reason: 'property-disappeared' });
    if (!hasOwn(descriptor, 'value')) {
      return tag('Accessor', { get: !!descriptor.get, set: !!descriptor.set });
    }
    return visit(descriptor.value, depth, at);
  }

  function properties(object, keys, depth, at) {
    const out = {};
    for (const key of keys) {
      // defineProperty also handles a literal "__proto__" without pollution.
      Object.defineProperty(out, key, {
        value: property(object, key, depth + 1, propertyPath(at, key)),
        enumerable: true, configurable: true, writable: true,
      });
    }
    return out;
  }

  function visit(input, depth, at) {
    if (input === null) return null;
    switch (typeof input) {
      case 'undefined': return tag('Undefined');
      case 'bigint': return tag('BigInt', { value: String(input) });
      case 'function': {
        const name = Object.getOwnPropertyDescriptor(input, 'name')?.value;
        return tag('Function', { name: typeof name === 'string' ? name : '' });
      }
      case 'symbol': return tag('Symbol', { value: String(input), key: Symbol.keyFor(input) ?? null });
      case 'number':
        if (!Number.isFinite(input)) return tag('Number', { value: String(input) });
        if (Object.is(input, -0)) return tag('Number', { value: '-0' });
        return input;
      case 'object': break;
      default: return input;
    }

    if (ancestors.has(input)) {
      const referencePath = ancestors.get(input);
      serialization.cycleCount++;
      serialization.cycles.push({ path: at, referencePath });
      return tag('Circular', { path: at, $ref: referencePath });
    }

    // Leaf-like built-ins have no traversed children, so do not consume depth.
    if (input instanceof Date) {
      const time = Date.prototype.getTime.call(input);
      return tag('Date', { value: Number.isNaN(time) ? 'Invalid Date' : new Date(time).toISOString() });
    }
    if (input instanceof RegExp) return tag('RegExp', { value: String(input) });

    const kind = Buffer.isBuffer(input) ? 'Buffer'
      : Array.isArray(input) ? 'Array'
        : input instanceof Map ? 'Map'
          : input instanceof Set ? 'Set'
            : ArrayBuffer.isView(input) ? 'TypedArray'
              : input instanceof ArrayBuffer ? 'ArrayBuffer'
                : input instanceof Error ? 'Error' : 'Object';
    const originalCount = kind === 'Buffer' || kind === 'Array' ? input.length
      : kind === 'Map' || kind === 'Set' ? input.size
        : kind === 'TypedArray' ? (input.length ?? input.byteLength)
          : kind === 'ArrayBuffer' ? input.byteLength : Object.keys(input).length;
    if (depth > maxDepth) return truncation(at, 'max-depth', kind, originalCount, 0);

    ancestors.set(input, at);
    try {
      if (kind === 'Buffer' || kind === 'ArrayBuffer' || input instanceof DataView) {
        const bytes = kind === 'Buffer' ? input
          : kind === 'ArrayBuffer' ? Buffer.from(input)
            : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        const retainedCount = Math.min(bytes.length, maxArrayLength);
        const out = tag(kind === 'TypedArray' ? 'DataView' : kind, {
          encoding: 'base64', byteLength: bytes.length,
          data: bytes.subarray(0, retainedCount).toString('base64'),
        });
        if (retainedCount < bytes.length) {
          out.truncation = truncation(at, 'max-array-length', out.$type, bytes.length, retainedCount);
        }
        return out;
      }
      if (kind === 'Array' || kind === 'TypedArray') {
        const retainedCount = Math.min(input.length, maxArrayLength);
        const items = [];
        for (let i = 0; i < retainedCount; i++) {
          items.push(hasOwn(input, i)
            ? property(input, String(i), depth + 1, `${at}[${i}]`)
            : tag('ArrayHole'));
        }
        if (retainedCount < input.length) {
          items.push(truncation(at, 'max-array-length', kind, input.length, retainedCount));
        }
        if (kind === 'TypedArray') {
          return tag(Object.getPrototypeOf(input)?.constructor?.name ?? 'TypedArray', {
            length: input.length, values: items,
          });
        }
        return items;
      }
      if (kind === 'Map' || kind === 'Set') {
        const retainedCount = Math.min(input.size, maxArrayLength);
        const items = [];
        let i = 0;
        for (const entry of kind === 'Map' ? Map.prototype.entries.call(input) : Set.prototype.values.call(input)) {
          if (i >= retainedCount) break;
          items.push(kind === 'Map'
            ? [visit(entry[0], depth + 1, `${at}.entries[${i}][0]`),
              visit(entry[1], depth + 1, `${at}.entries[${i}][1]`)]
            : visit(entry, depth + 1, `${at}.values[${i}]`));
          i++;
        }
        const out = tag(kind, { size: input.size, [kind === 'Map' ? 'entries' : 'values']: items });
        if (retainedCount < input.size) {
          out.truncation = truncation(at, 'max-array-length', kind, input.size, retainedCount);
        }
        return out;
      }
      const keys = Object.keys(input);
      if (kind === 'Error') {
        for (const key of ['name', 'message', 'stack', 'cause']) {
          if (hasOwn(input, key) && !keys.includes(key)) keys.push(key);
        }
      }
      const out = properties(input, keys, depth, at);
      const symbols = Object.getOwnPropertySymbols(input)
        .filter((key) => Object.getOwnPropertyDescriptor(input, key)?.enumerable);
      if (symbols.length) {
        const retainedCount = Math.min(symbols.length, maxArrayLength);
        const symbolProperties = symbols.slice(0, retainedCount).map((key, i) => ({
          key: visit(key, depth + 1, `${at}.symbolProperties[${i}].key`),
          value: property(input, key, depth + 1, `${at}.symbolProperties[${i}].value`),
        }));
        const tagged = tag(kind, { properties: out, symbolProperties });
        if (retainedCount < symbols.length) {
          tagged.truncation = truncation(`${at}.symbolProperties`, 'max-array-length', 'SymbolProperties', symbols.length, retainedCount);
        }
        return tagged;
      }
      return kind === 'Error' ? tag('Error', { properties: out }) : out;
    } finally {
      ancestors.delete(input);
    }
  }

  return { value: visit(value, initialDepth, '$'), serialization };
}

/**
 * Backwards-compatible value-only API. Unlike the old implementation, every
 * bounded omission has an inline, self-explanatory marker. Prefer
 * sanitizeWithMeta when paths/counts must also be consumed programmatically.
 */
export function sanitize(value, options = {}) {
  return sanitizeWithMeta(value, options).value;
}

function attachSerialization(value, serialization) {
  const inputMeta = value.meta;
  const meta = inputMeta && typeof inputMeta === 'object' && !Array.isArray(inputMeta)
    ? inputMeta : inputMeta === undefined ? {} : { value: inputMeta };
  // meta.serialization is reserved output metadata. Attach it LAST and do not
  // sanitize this result again: that would truncate the truncation records.
  return { ...value, meta: { ...meta, serialization } };
}

async function writeJsonAtomically(target, envelope) {
  // Resolve first, and create an exclusive sibling so rename never exposes a
  // partially written JSON file. No unlink-and-retry: a failed write/rename
  // must leave an existing destination untouched. Parent directories must exist.
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const text = JSON.stringify(envelope, null, 2) + '\n';
  let handle;
  let created = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
    created = false;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
  }
}

/**
 * Prepare a raw CLI envelope ONCE at the final output boundary.
 *
 * Returns the bounded envelope directly. meta.serialization contains all
 * truncation paths/originalCount/retainedCount/reasons and cycle paths. A null
 * limit in that metadata means unlimited. resultOut, when provided, receives
 * a separate COMPLETE JSON-safe envelope (Infinity/Infinity; cycles marked),
 * written atomically before this promise resolves. Both envelopes record its
 * absolute path in meta.serialization.resultOut.
 *
 * A failed export rejects with CliError(code=result-out-failed, exitCode=1).
 * The caller must emit that error WITHOUT retrying the failed resultOut.
 * Invalid options reject with exitCode=4. No file is written without resultOut.
 */
export async function prepareEnvelope(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CliError('an output envelope must be an object', {
      exitCode: EXIT.CONFIG, code: 'bad-output-envelope',
    });
  }
  const bounded = sanitizeWithMeta(payload, options);
  const envelope = attachSerialization(bounded.value, bounded.serialization);
  if (options.resultOut === undefined) return envelope;
  if (typeof options.resultOut !== 'string' || !options.resultOut.trim() || options.resultOut.includes('\0')) {
    throw new CliError('resultOut must be a non-empty file path', {
      exitCode: EXIT.CONFIG, code: 'bad-result-out',
    });
  }
  const target = path.resolve(options.resultOut);
  const exported = { path: target, written: true, complete: true };
  bounded.serialization.resultOut = exported;
  try {
    const full = sanitizeWithMeta(payload, { maxArrayLength: Infinity, maxDepth: Infinity });
    full.serialization.resultOut = { ...exported };
    await writeJsonAtomically(target, attachSerialization(full.value, full.serialization));
  } catch (error) {
    throw new CliError(`cannot write resultOut ${JSON.stringify(target)}: ${error?.message ?? error}`, {
      exitCode: EXIT.RUNTIME,
      code: 'result-out-failed',
      data: { resultOut: target, causeCode: error?.code ?? null },
    });
  }
  return envelope;
}

/** Race a promise against a timeout, tagging the failure as unreachable/busy. */
export function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new CliError(`${label} timed out after ${ms}ms`, {
          exitCode: EXIT.UNREACHABLE,
          code: 'timeout',
        }),
      );
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
