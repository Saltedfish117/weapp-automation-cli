#!/usr/bin/env node
/**
 * weapp - WeChat DevTools automation CLI.
 *
 * Contract: one JSON envelope on stdout, logs on stderr, meaningful exit codes:
 *   0 ok | 1 runtime | 2 assertion/visual mismatch | 3 devtools unreachable | 4 config/args
 *
 * Usage: weapp <command> [args] [--flag value]
 *        weapp help
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PACKAGE } from '../package.mjs';
import { installationHealth } from '../installer/health.mjs';

import { CliError, EXIT, emitAsync, prepareEnvelope, log, sanitize, withTimeout } from './lib/output.mjs';
import { resolveConfig } from './lib/config.mjs';
import { withSession } from './lib/session.mjs';
import { loadAutomator, probePort, lockPath, readLockInfo, PACKAGE_ROOT } from './lib/lock.mjs';
import { describeElement, toBox } from './lib/selectors.mjs';
import { queryRoot, chooseElement, textMatches, selectTextMatch } from './lib/interaction.mjs';
import { nativeProbe, assessNativeNodes, validateNativeProbeOptions, validateNativeNodesSpec } from './lib/validation.mjs';
import { readNativeScroll, observeScroll, attemptSwipe } from './lib/scroll-check.mjs';
import { createEvidence } from './lib/evidence.mjs';
import { validateResultPath, validateArtifactPath } from './lib/result-path.mjs';
import { readyFor, validateReadyAdapterSpec } from './lib/ready-adapter.mjs';
import {
  capturePngGuarded,
  writePng,
  cropPng,
  comparePng,
  defaultShotPath,
  imageSize,
  intersectBox,
  maskPng,
} from './lib/shot.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOOLEAN_FLAGS = new Set([
  'help',
  'launch',
  'restart',
  'strict-version',
  'raw',
  'wxml',
  'update-baseline',
  'assert',
  'force',
  'keep-mocks',
  'allow-other-project',
  'blur',
  'confirm',
  'exact',
  'gone',
  'wait-gone',
  'strict',
  'no-diagnostics',
  'attach-only',
]);

// Extra flags that may legitimately appear without a value (an empty style
// list is useful for `find --style`).
const BARE_VALUE_FLAGS = new Set(['style']);

const VALUE_FLAGS = new Set([
  'project',
  'cli',
  'port',
  'timeout',
  'lock-wait',
  'connect-timeout',
  'launch-timeout',
  'wait-ms',
  'shot-timeout',
  'settle-ms',
  'run-timeout',
  'wait-timeout',
  'wait-for',
  'interval',
  'selector',
  'text',
  'tag',
  'out',
  'baseline',
  'mask',
  'label',
  'pad',
  'threshold',
  'pixel-threshold',
  'limit',
  'index',
  'top',
  'left',
  'value',
  'type',
  'detail',
  'fn',
  'data',
  'url',
  'within',
  'spec',
  'result-out',
  'evidence-dir',
  'evidence',
]);

const KNOWN_FLAGS = new Set([...BOOLEAN_FLAGS, ...VALUE_FLAGS, ...BARE_VALUE_FLAGS]);

function configError(message, code = 'bad-flag') {
  return new CliError(message, { exitCode: EXIT.CONFIG, code });
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      let key = token.slice(2);
      let value = true;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        value = argv[++i];
      }
      flags[key] = value;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function validateFlags(flags) {
  for (const key of Object.keys(flags)) {
    if (!KNOWN_FLAGS.has(key)) {
      throw configError(`unknown flag: --${key}. Run "weapp help" for supported flags.`, 'unknown-flag');
    }
  }
  for (const key of VALUE_FLAGS) {
    if (flags[key] === true) {
      throw configError(`--${key} needs a value`, 'missing-flag-value');
    }
  }
  if (boolFlag(flags, 'attach-only') && (boolFlag(flags, 'restart') || boolFlag(flags, 'launch'))) {
    throw configError('--attach-only cannot be combined with --restart or --launch', 'conflicting-flags');
  }
  if (flags.help !== undefined) boolFlag(flags, 'help');
}

function boolFlag(flags, key, fallback = false) {
  const value = flags[key];
  if (value === undefined) return fallback;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0' || value === '') return false;
  throw configError(`--${key} is a boolean flag; got "${value}"`, 'bad-boolean');
}

function stringFlag(flags, key, fallback = null, { allowEmpty = false } = {}) {
  const value = flags[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw configError(`--${key} needs a value`, 'missing-flag-value');
  }
  if (!allowEmpty && value === '') {
    throw configError(`--${key} needs a non-empty value`, 'missing-flag-value');
  }
  return value;
}

function numberFlag(
  flags,
  key,
  fallback,
  { min = 0, max = Infinity, integer = false, allowZero = true } = {},
) {
  const value = flags[key];
  if (value === undefined) return fallback;
  if (typeof value === 'boolean' || value === '') {
    throw configError(`--${key} needs a numeric value`, 'missing-flag-value');
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw configError(`--${key} must be a number, got "${value}"`, 'bad-number');
  }
  if (n < min || n > max) {
    throw configError(`--${key} must be between ${min} and ${max}`, 'bad-number');
  }
  if (integer && !Number.isInteger(n)) {
    throw configError(`--${key} must be an integer`, 'bad-number');
  }
  if (!allowZero && n === 0) {
    throw configError(`--${key} must be greater than 0`, 'bad-number');
  }
  return n;
}

function requireArg(args, index, name) {
  const value = args[index];
  if (value === undefined) {
    throw new CliError(`missing argument: ${name}`, { exitCode: EXIT.CONFIG, code: 'missing-arg' });
  }
  return value;
}

function readTextArg(value, label = 'value') {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('@')) return value;
  const file = path.resolve(process.cwd(), value.slice(1));
  try {
    // Windows PowerShell 5.1 `Set-Content -Encoding UTF8` writes a BOM.
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    throw new CliError(`cannot read ${label} file ${file}: ${err.message}`, {
      exitCode: EXIT.CONFIG,
      code: 'bad-file',
    });
  }
}

function parseJsonArg(value, label) {
  try {
    return JSON.parse(readTextArg(value, label));
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`${label} is not valid JSON: ${err.message}`, {
      exitCode: EXIT.CONFIG,
      code: 'bad-json',
    });
  }
}

/**
 * The devtools protocol prepends "wx." itself, so `wx.showToast` becomes
 * `wx.wx.showToast not exists`. Accept both spellings and send the bare name.
 */
function normalizeWxApi(name) {
  return String(name).trim().replace(/^wx\./i, '');
}

function mapDevtoolsError(err, context = {}) {
  if (err instanceof CliError) return err;
  const message = err?.message ?? String(err);
  if (Number.isInteger(err?.exitCode) && err?.code) return new CliError(message, { exitCode: err.exitCode, code: err.code, data: err.data });
  if (/querySelector|not a valid selector|selector is empty|invalid selector/i.test(message)) {
    return new CliError(
      `invalid selector${context.selector ? ` "${context.selector}"` : ''}: ${message}`,
      { exitCode: EXIT.CONFIG, code: 'bad-selector' },
    );
  }
  if (/websocket|connection|closed|disconnect|ECONNRESET|not open/i.test(message)) {
    return new CliError(`devtools connection lost: ${message}`, {
      exitCode: EXIT.UNREACHABLE,
      code: 'connection-lost',
    });
  }
  if (/unexpected token|syntaxerror/i.test(message)) {
    return new CliError(message, { exitCode: EXIT.CONFIG, code: 'bad-expression' });
  }
  if (/tabbar page|not found|invalid url|page .* does not exist/i.test(message)) {
    return new CliError(message, { exitCode: EXIT.CONFIG, code: 'bad-route' });
  }
  if (/not exist|not supported|no such method|not implemented/i.test(message)) {
    return new CliError(message, { exitCode: EXIT.CONFIG, code: 'unsupported' });
  }
  return new CliError(message, { exitCode: EXIT.RUNTIME, code: 'devtools-error' });
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function currentPageOrThrow(mp) {
  const page = await mp.currentPage();
  if (!page) {
    throw new CliError('devtools reported no current page (is the simulator open?)', {
      exitCode: EXIT.UNREACHABLE,
      code: 'no-page',
    });
  }
  return page;
}

function pageInfo(page) {
  return page ? { path: page.path, query: page.query } : null;
}

async function changeRoute(session, method, target, waitMs) {
  const expected = target ? String(target).split('?')[0].replace(/^\//, '') : null;
  const settleMs = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0;
  const NAV_TIMEOUT_MS = 10_000;
  // Only navigateTo can legitimately be on the stack but not current; the
  // other modes make the target the current page.
  const allowStackRecovery = method === 'navigateTo';
  const finish = async (page, extra = {}) => {
    if (settleMs > 0) await sleep(settleMs);
    return { mode: method, target: target ?? null, page: pageInfo(page), ...extra };
  };
  const stackOf = async () => session.mp.pageStack().catch(() => []);

  if (method === 'navigateBack') {
    let before = [];
    try {
      before = await session.mp.pageStack();
    } catch {
      /* optional */
    }
    if (before.length <= 1) {
      return finish(before[0] ?? null, { noop: true });
    }
    const beforePath = before[before.length - 1]?.path ?? null;
    let callError = null;
    try {
      // wx.navigateBack is not reliable through callWxMethod({delta}); use
      // automator's wrapper, which performs the real route change.
      await session.mp.navigateBack();
    } catch (err) {
      callError = err;
    }
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    let page = null;
    while (Date.now() < deadline) {
      page = await session.mp.currentPage().catch(() => null);
      const stack = await stackOf();
      const wentBack =
        page && (stack.length < before.length || (beforePath && page.path !== beforePath));
      if (wentBack) {
        return finish(page, callError ? { recovered: true, warning: callError.message } : {});
      }
      await sleep(150);
    }
    if (callError) throw mapDevtoolsError(callError);
    throw new CliError(
      `navigateBack did not complete within ${NAV_TIMEOUT_MS}ms. ` +
        `The page may guard back; try "native navigateLeft", "native cancelModal", or "up --restart".`,
      {
        exitCode: EXIT.RUNTIME,
        code: 'navigation-timeout',
        data: { current: pageInfo(page), before: before.map(pageInfo) },
      },
    );
  }

  const callState = { done: false, value: null, error: null };
  session.mp.callWxMethod(method, { url: target }).then(
    (value) => {
      callState.done = true;
      callState.value = value;
    },
    (error) => {
      callState.done = true;
      callState.error = error;
    },
  );

  const deadline = Date.now() + NAV_TIMEOUT_MS;
  let page = null;

  while (Date.now() < deadline) {
    page = await session.mp.currentPage().catch(() => null);
    if (page?.path === expected) {
      return finish(page);
    }
    if (callState.error) {
      // Give the page a moment to appear even when automator reported timeout.
      await sleep(250);
      page = await session.mp.currentPage().catch(() => null);
      if (page?.path === expected) {
        return finish(page, { recovered: true, warning: callState.error.message });
      }
      if (allowStackRecovery) {
        const stack = await stackOf();
        const landed = page ?? stack.find((p) => p.path === expected) ?? null;
        if (landed) {
          log(`[weapp] ${method} reported "${callState.error.message}" but ${expected} is on the page stack; continuing`);
          return finish(landed, { recovered: true, warning: callState.error.message });
        }
      }
      throw mapDevtoolsError(callState.error);
    }
    await sleep(150);
  }

  page = await session.mp.currentPage().catch(() => null);
  if (page?.path === expected) {
    return finish(page);
  }
  if (allowStackRecovery) {
    const stack = await stackOf();
    const landed = stack.find((p) => p.path === expected) ?? null;
    if (landed) {
      return finish(landed, {
        recovered: true,
        warning: callState.error?.message ?? 'navigation callback did not settle in time',
      });
    }
  }
  const stack = await stackOf();
  throw new CliError(
    `navigation to ${target} did not complete within ${NAV_TIMEOUT_MS}ms (current: ${page?.path ?? 'unknown'}). ` +
      `If the page guards navigation, use "up --restart"; tabbar routes need "switch-tab".`,
    {
      exitCode: EXIT.RUNTIME,
      code: 'navigation-timeout',
      data: { target, expected, current: pageInfo(page), stack: stack.map(pageInfo) },
    },
  );
}

function parseStyles(flags) {
  const raw = flags.style;
  if (!raw || raw === true) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Element.$() swallows all devtools errors and returns null, which makes an
 * invalid selector look like "not found". On a miss, query all to distinguish
 * the two (and to surface a lost connection).
 */
async function findElement(page, selector, index = null) {
  if (index !== null && index !== undefined) {
    let elements;
    try {
      elements = await page.$$(selector);
    } catch (err) {
      throw mapDevtoolsError(err, { selector });
    }
    if (elements.length === 0) return { element: null, count: 0, index };
    if (index >= elements.length) {
      throw new CliError(
        `selector "${selector}" matched ${elements.length} element(s); --index ${index} is out of range`,
        {
          exitCode: EXIT.ASSERT,
          code: 'index-out-of-range',
          data: { selector, count: elements.length, index },
        },
      );
    }
    return { element: elements[index], count: elements.length, index };
  }

  const element = await page.$(selector);
  if (element) return { element, count: null, index: null };
  try {
    await page.$$(selector);
  } catch (err) {
    throw mapDevtoolsError(err, { selector });
  }
  return { element: null, count: 0, index: null };
}

async function findElementOrThrow(page, selector, index = null) {
  const found = await findElement(page, selector, index);
  if (!found.element) {
    throw new CliError(`element not found: ${selector}`, {
      exitCode: EXIT.ASSERT,
      code: 'element-not-found',
    });
  }
  return found.element;
}

/**
 * Find elements by visible text. Sorted so the most specific (text/button,
 * then smallest view) comes first, which makes tap-text bubble from the leaf
 * to the real click handler in composite rows.
 */
async function collectTextMatchesLegacy(page, query, { exact = false, tag = null } = {}) {
  const tags = tag ? [tag] : ['text', 'button', 'view'];
  const seen = new Set();
  const matches = [];
  let scanned = 0;
  for (const tagName of tags) {
    let elements;
    try {
      elements = await page.$$(tagName);
    } catch (err) {
      throw mapDevtoolsError(err);
    }
    for (const element of elements) {
      if (++scanned > 1500) break;
      let text;
      try {
        text = await element.text();
      } catch {
        continue;
      }
      const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      if (exact ? normalized !== query : !normalized.includes(query)) continue;
      const size = await element.size().catch(() => null);
      const offset = await element.offset().catch(() => null);
      if (!size || !offset) continue;
      const width = Number.parseFloat(size.width);
      const height = Number.parseFloat(size.height);
      const left = Number.parseFloat(offset.left);
      const top = Number.parseFloat(offset.top);
      if (!(width > 0 && height > 0)) continue;
      const key = `${tagName}|${left}|${top}|${width}|${height}|${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const className = await element.attribute('class').catch(() => null);
      matches.push({
        element,
        tagName,
        text: normalized,
        size: { width, height },
        offset: { left, top },
        className,
        area: width * height,
      });
    }
    if (scanned > 1500) break;
  }
  const priority = { text: 0, button: 1, view: 2 };
  matches.sort(
    (a, b) =>
      (priority[a.tagName] ?? 9) - (priority[b.tagName] ?? 9) ||
      a.area - b.area ||
      a.offset.top - b.offset.top ||
      a.offset.left - b.offset.left,
  );
  return matches;
}

function describeTextMatch(match) {
  return {
    tagName: match.tagName,
    text: match.text,
    size: match.size,
    offset: match.offset,
    className: match.className,
    area: match.area,
  };
}

async function waitForSelector(page, selector, { gone = false, timeoutMs = 5000, interval = 100 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    let count;
    try {
      const current = typeof page === 'function' ? await page() : page;
      if (!current) throw new CliError('current page unavailable while waiting', { exitCode: EXIT.UNREACHABLE, code: 'no-page' });
      count = (await current.$$(selector)).length;
    } catch (err) {
      throw mapDevtoolsError(err, { selector });
    }
    const found = count > 0;
    if (gone ? !found : found) {
      return { selector, gone, found, count, elapsedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new CliError(
        `wait-for ${selector} timed out after ${timeoutMs}ms (${gone ? 'still present' : 'never appeared'})`,
        {
          exitCode: EXIT.ASSERT,
          code: 'wait-timeout',
          data: { selector, gone, count, timeoutMs, elapsedMs: Date.now() - startedAt },
        },
      );
    }
    await sleep(interval);
  }
}

async function pageScrollTop(page) {
  try {
    const value = await page.scrollTop();
    if (value === null || value === undefined) return null;
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function pollScroll(read, target, timeoutMs = 1000) {
  let value = await read();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && Number.isFinite(value) && Math.abs(value - target) > 1) {
    await sleep(100);
    value = await read();
  }
  return value;
}

function resolveBaselinePath(cwd, baselineArg, written) {
  const abs = path.resolve(cwd, baselineArg);
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    /* path does not exist yet */
  }
  if (stat?.isFile()) return abs;
  if (stat?.isDirectory()) return path.join(abs, path.basename(written));
  return /\.png$/i.test(baselineArg) ? abs : path.join(abs, path.basename(written));
}

function diffPathFor(written) {
  return /\.png$/i.test(written) ? written.replace(/\.png$/i, '.diff.png') : `${written}.diff.png`;
}

async function captureShot(
  session,
  {
    cwd,
    outPath,
    selector,
    index = null,
    pad = 0,
    baseline,
    mask = null,
    threshold = 0.1,
    pixelThreshold = 0.1,
    updateBaseline = false,
    label = null,
    settleMs = 0,
    shotTimeout = 15000,
  },
) {
  const page = await currentPageOrThrow(session.mp);
  if (settleMs > 0) await sleep(settleMs);
  if (mask && selector) {
    throw new CliError('--mask cannot be combined with --selector; mask areas are full-page coordinates', {
      exitCode: EXIT.CONFIG,
      code: 'mask-selector-conflict',
    });
  }

  // Resolve and measure the element before taking the screenshot: a missing
  // or invalid selector should fail fast and should not need a captured frame.
  let selectorBox = null;
  if (selector) {
    const element = await findElementOrThrow(page, selector, index);
    selectorBox = toBox(await element.size(), await element.offset());
    if (!selectorBox) {
      throw new CliError(`element has no measurable size/offset: ${selector}`, {
        exitCode: EXIT.ASSERT,
        code: 'element-not-measurable',
        data: { selector },
      });
    }
    // Fast path for the common "scrolled above the viewport" case: fail
    // without waiting for a screenshot that cannot contain the element.
    if (selectorBox.top + selectorBox.height <= 0) {
      const viewport = await page.size().catch(() => null);
      throw new CliError(
        `element "${selector}" is above the viewport (box ${JSON.stringify(selectorBox)})`,
        {
          exitCode: EXIT.ASSERT,
          code: 'element-not-visible',
          data: { selector, box: selectorBox, viewport },
        },
      );
    }
  }

  let buffer = await capturePngGuarded(session.mp, shotTimeout);
  const fullViewport = imageSize(buffer);
  let cropped = null;
  let maskInfo = null;
  let maskBoxes = [];

  if (mask) {
    const selectors = String(mask)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (selectors.length === 0) {
      throw new CliError('--mask needs at least one selector', {
        exitCode: EXIT.CONFIG,
        code: 'bad-mask',
      });
    }
    const viewport = fullViewport;
    const regions = [];
    for (const maskSelector of selectors) {
      let elements;
      try {
        elements = await page.$$(maskSelector);
      } catch (err) {
        throw mapDevtoolsError(err, { selector: maskSelector });
      }
      const boxes = [];
      for (const element of elements) {
        const box = toBox(
          await element.size().catch(() => null),
          await element.offset().catch(() => null),
        );
        if (!box) continue;
        const clipped = intersectBox(box, {
          left: 0,
          top: 0,
          width: viewport.width,
          height: viewport.height,
        });
        if (clipped) {
          boxes.push(clipped);
          maskBoxes.push(clipped);
        }
      }
      regions.push({ selector: maskSelector, count: elements.length, boxes });
    }
    maskInfo = { selectors, regions, boxCount: maskBoxes.length };
  }

  if (selector) {
    const box = selectorBox;
    const viewport = fullViewport;
    const target = {
      left: box.left - pad,
      top: box.top - pad,
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    };
    const crop = intersectBox(target, {
      left: 0,
      top: 0,
      width: viewport.width,
      height: viewport.height,
    });
    if (!crop) {
      throw new CliError(
        `element "${selector}" is outside the ${viewport.width}x${viewport.height} viewport (box ${JSON.stringify(box)})`,
        {
          exitCode: EXIT.ASSERT,
          code: 'element-not-visible',
          data: { selector, box, viewport },
        },
      );
    }
    buffer = cropPng(buffer, crop, 0);
    cropped = {
      selector,
      index,
      box,
      viewport,
      cropBox: {
        left: Math.round(crop.left),
        top: Math.round(crop.top),
        width: Math.round(crop.width),
        height: Math.round(crop.height),
      },
      padding: pad,
      clipped: crop.width < target.width - 0.5 || crop.height < target.height - 0.5,
    };
  }

  // Compare the final image (cropped for --selector, masked for --mask), not
  // the original full-page capture. Baseline is written from the same image.
  const compareBuffer = maskBoxes.length > 0 ? maskPng(buffer, maskBoxes) : buffer;

  const written = writePng(outPath ?? defaultShotPath(cwd, page.path, label), buffer);
  const result = {
    page: page.path,
    path: written,
    bytes: buffer.length,
    viewport: fullViewport,
    cropped,
    masked: maskInfo,
    baseline: null,
  };
  let exitCode = EXIT.OK;

  if (baseline) {
    const baselinePath = resolveBaselinePath(cwd, baseline, written);
    if (!fs.existsSync(baselinePath)) {
      if (updateBaseline) {
        writePng(baselinePath, buffer);
        result.baseline = { path: baselinePath, created: true };
      } else {
        throw new CliError(
          `baseline not found: ${baselinePath}. Re-run with --update-baseline to create it.`,
          { exitCode: EXIT.CONFIG, code: 'no-baseline', data: result },
        );
      }
    } else if (updateBaseline) {
      // A corrupt old baseline must not prevent repairing it.
      let previousMismatchPct = null;
      try {
        const baselineRaw = fs.readFileSync(baselinePath);
        const baselineCompare = maskBoxes.length > 0 ? maskPng(baselineRaw, maskBoxes) : baselineRaw;
        previousMismatchPct = comparePng(baselineCompare, compareBuffer, {
          pixelThreshold,
        }).mismatchPct;
      } catch (err) {
        if (!(err instanceof CliError) || err.code !== 'bad-png') throw err;
      }
      writePng(baselinePath, buffer);
      result.baseline = { path: baselinePath, updated: true, previousMismatchPct };
    } else {
      const baselineRaw = fs.readFileSync(baselinePath);
      const baselineCompare = maskBoxes.length > 0 ? maskPng(baselineRaw, maskBoxes) : baselineRaw;
      const comparison = comparePng(baselineCompare, compareBuffer, { pixelThreshold });
      const passed = !comparison.sizeMismatch && comparison.mismatchPct <= threshold;
      let diffPath = null;
      if (!passed && comparison.diffBuffer) {
        diffPath = diffPathFor(written);
        writePng(diffPath, comparison.diffBuffer);
      }
      result.baseline = {
        path: baselinePath,
        passed,
        threshold,
        mismatchPct: comparison.mismatchPct,
        diffPixels: comparison.diffPixels,
        sizeMismatch: comparison.sizeMismatch,
        baselineSize: comparison.baseline,
        currentSize: comparison.current,
        diffPath,
      };
      if (!passed) exitCode = EXIT.ASSERT;
    }
  }

  return {
    exitCode,
    code: exitCode === EXIT.ASSERT ? 'visual-mismatch' : undefined,
    message: exitCode === EXIT.ASSERT ? 'visual baseline mismatch' : undefined,
    data: result,
  };
}

function nativeMethods(nativeApi) {
  const names = new Set();
  // Native methods live directly on Native.prototype. Walking further reaches
  // EventEmitter and would advertise addListener/on/... as native actions.
  const proto = Object.getPrototypeOf(nativeApi);
  if (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (['constructor', 'send', 'sendNative'].includes(name)) continue;
      if (typeof nativeApi[name] === 'function') names.add(name);
    }
  }
  return [...names].sort();
}

/* ------------------------------------------------------------------ commands */

const commands = {
  help() {
    return {
      usage: 'weapp <command> [args] [--flags]',
      commands: {
        install: 'install - detect agents and install shared or copied skills (weapp install --help)',
        skills: 'skills list|sync|uninstall - manage registered agent skills',
        update: 'update - update global CLI and synchronize registered skills',
        doctor: 'environment self-check',
        up: 'attach, or launch when the port is closed (--launch alias; --restart closes and relaunches)',
        open: 'open <pagePathWithQuery> via reLaunch',
        navigate: 'navigate <pagePathWithQuery> via navigateTo',
        redirect: 'redirect <pagePathWithQuery> via redirectTo',
        'switch-tab': 'switch-tab <pagePath> via switchTab',
        back: 'navigateBack',
        stack: 'page stack paths/queries',
        page: 'current page path, query, size, data keys',
        data: 'data [keyPath] - page data (dotted path supported)',
        eval: 'eval <expression|@file> - evaluate in the logic layer (--raw for a full function)',
        find: 'find <selector> [--index n] - element size/offset/text/style (--assert to fail when missing)',
        'find-all': 'find-all <selector> - list matching elements (--assert to fail when empty)',
        'find-text': 'find-text <text> [--exact] [--tag text|button|view] [--limit n]',
        tap: 'tap <selector> [--index n] [--wait-for sel] [--wait-gone]',
        'tap-text': 'tap-text <text> [--exact] [--tag text|button|view] [--index n] [--wait-for sel] [--wait-gone]',
        input: 'input <selector> [--index n] --value <text> [--confirm] [--blur]',
        'wait-for': 'wait-for <selector> [--gone] [--wait-timeout ms] [--interval ms]',
        probe: 'probe <selector> or --spec @file - native geometry/style/dataset snapshot (read-only)',
        'assert-nodes': 'assert-nodes --spec @file - joint business key, actual rect/style/content and coverage assertions',
        ready: 'ready --spec @file - combine route/data/selector/native-layout/scroll stable conditions',
        swipe: 'swipe <scroll-view> --spec @file - SDK touch attempt plus measured displacement; real gesture remains uncovered',
        'scroll-observe': 'scroll-observe [--spec @file] - native offset trace; no input dispatch',
        output: '--result-out result.json exports full JSON-safe output; stdout preview has explicit truncation metadata',
        diagnostics: '--evidence-dir dir saves failure state/screenshot; --no-diagnostics disables sensitive snapshots',
        targeting: 'tap/tap-text/input/trigger --strict --within <unique-container> prevent ambiguous targets',
        trigger: 'trigger <selector> [--index n] --type <event> [--detail <json|@file>]',
        scroll: 'scroll --top <px> [--selector <scroll-view>] [--index n]',
        shot: 'shot [--out file] [--selector sel] [--index n] [--pad px] [--baseline dir|file] [--mask sel1,sel2] [--threshold pct] [--settle-ms ms]',
        mock: 'mock <wxApi> <json|@file> [--fn <body|@file>]',
        restore: 'restore <wxApi>',
        audit: 'audit [report|stop] [--out file] - stop/fetch an audit started in DevTools',
        native: 'native <action> [--data <json|@file>|--url <url>]',
        ticket: 'ticket get|set <value>|refresh',
        run: 'run <script.mjs> [--run-timeout ms] [--keep-mocks]',
        lock: 'lock status|clear [--force] - inspect/clear the per-port lock',
      },
      notes: [
        'stdout is always one JSON envelope; logs go to stderr',
        'exit codes: 0 ok, 1 runtime, 2 assertion, 3 unreachable, 4 config',
        'normal commands never call MiniProgram.close(); up --restart is the explicit exception',
        'use @file for JSON on PowerShell (nested quotes are fragile)',
      ],
      packageRoot: PACKAGE_ROOT,
      version: PACKAGE.version,
    };
  },

  async doctor({ config }) {
    let automatorVersion = null;
    let automatorError = null;
    try {
      automatorVersion = loadAutomator().version;
    } catch (err) {
      automatorError = err.message;
    }

    const portListening = await probePort(config.port);
    const projectConfig = config.projectPath
      ? path.join(config.projectPath, 'project.config.json')
      : null;
    const miniprogramRoot = config.miniprogramRoot ?? null;
    const projectOk = Boolean(miniprogramRoot);
    const cliOk = Boolean(config.cliPath && isFile(config.cliPath));
    const canAttach = portListening;
    const canLaunch = cliOk && projectOk;
    const ok = Boolean(automatorVersion) && (canAttach || canLaunch);

    return {
      exitCode: ok ? EXIT.OK : EXIT.CONFIG,
      data: {
        ok,
        node: process.version,
        platform: process.platform,
        packageRoot: PACKAGE_ROOT,
        version: PACKAGE.version,
        installation: installationHealth(),
        automator: automatorVersion
          ? { version: automatorVersion, installed: true }
          : { installed: false, error: automatorError, hint: 'Reinstall weapp-automation-cli with npm, then run weapp doctor.' },
        devtools: { cliPath: config.cliPath, exists: cliOk },
        project: {
          path: config.projectPath,
          projectConfig,
          miniprogramRoot,
          appid: config.appid ?? null,
          appidFile: config.appidFile ?? null,
          exists: projectOk,
        },
        port: { value: config.port, listening: portListening },
        launch: { canLaunch, mode: process.platform === 'win32' ? 'cmd.exe' : 'direct' },
        sources: config.sources,
        configFile: config.configFile,
        warnings: config.warnings,
      },
    };
  },

  async up({ config, flags }) {
    return withSession(config, flags, async (session) => {
      const page = await session.mp.currentPage();
      return {
        mode: session.mode,
        port: config.port,
        projectRoot: session.projectRoot,
        projectCheck: session.projectCheck,
        cliOutput: session.cliOutput,
        page: page ? { path: page.path, query: page.query } : null,
      };
    });
  },

  async open({ config, flags, args }) {
    const target = requireArg(args, 0, 'pagePath');
    const waitMs = numberFlag(flags, 'wait-ms', 1200, { min: 0, max: 60000 });
    return withSession(config, flags, async (session) =>
      changeRoute(session, 'reLaunch', target, waitMs),
    );
  },

  async navigate({ config, flags, args }) {
    const target = requireArg(args, 0, 'pagePath');
    const waitMs = numberFlag(flags, 'wait-ms', 500, { min: 0, max: 60000 });
    return withSession(config, flags, async (session) =>
      changeRoute(session, 'navigateTo', target, waitMs),
    );
  },

  async redirect({ config, flags, args }) {
    const target = requireArg(args, 0, 'pagePath');
    const waitMs = numberFlag(flags, 'wait-ms', 500, { min: 0, max: 60000 });
    return withSession(config, flags, async (session) =>
      changeRoute(session, 'redirectTo', target, waitMs),
    );
  },

  async 'switch-tab'({ config, flags, args }) {
    const target = requireArg(args, 0, 'pagePath');
    const waitMs = numberFlag(flags, 'wait-ms', 500, { min: 0, max: 60000 });
    return withSession(config, flags, async (session) =>
      changeRoute(session, 'switchTab', target, waitMs),
    );
  },

  async back({ config, flags }) {
    const waitMs = numberFlag(flags, 'wait-ms', 300, { min: 0, max: 60000 });
    return withSession(config, flags, async (session) =>
      changeRoute(session, 'navigateBack', undefined, waitMs),
    );
  },

  async stack({ config, flags }) {
    return withSession(config, flags, async (session) => {
      let pages;
      try {
        pages = await session.mp.pageStack();
      } catch (err) {
        throw mapDevtoolsError(err);
      }
      return { count: pages.length, pages: pages.map(pageInfo) };
    });
  },

  async page({ config, flags }) {
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);
      const data = (await page.data().catch(() => null)) ?? {};
      return {
        path: page.path,
        query: page.query,
        size: await page.size().catch(() => null),
        dataKeys: Object.keys(data),
      };
    });
  },

  async data({ config, flags, args }) {
    const keyPath = args[0];
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);
      const value = keyPath ? await page.data(keyPath) : await page.data();
      const found = keyPath ? value !== undefined : true;
      return {
        path: page.path,
        keyPath: keyPath ?? null,
        found,
        value: value === undefined ? null : value,
      };
    });
  },

  async eval({ config, flags, args }) {
    let code = readTextArg(requireArg(args, 0, 'expression'), 'expression');
    if (!boolFlag(flags, 'raw')) {
      // Put the closing paren on a new line so a trailing `// comment` can't
      // swallow it.
      code = `() => (\n${code}\n)`;
    }
    return withSession(config, flags, async (session) => {
      try {
        const result = await session.mp.evaluate(code);
        return { expression: code, result };
      } catch (err) {
        throw mapDevtoolsError(err);
      }
    });
  },

  async find({ config, flags, args }) {
    const selector = requireArg(args, 0, 'selector');
    const index = numberFlag(flags, 'index', null, { min: 0, max: 10000, integer: true });
    const assert = boolFlag(flags, 'assert');
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);
      const found = await findElement(page, selector, index);
      if (!found.element) {
        if (assert) {
          throw new CliError(`element not found: ${selector}`, {
            exitCode: EXIT.ASSERT,
            code: 'element-not-found',
          });
        }
        return { selector, found: false, element: null, index, count: found.count };
      }
      const described = await describeElement(found.element, {
        styles: parseStyles(flags),
        wxml: boolFlag(flags, 'wxml'),
      });
      return { selector, found: true, element: described, index, count: found.count };
    });
  },

  async 'find-all'({ config, flags, args }) {
    const selector = requireArg(args, 0, 'selector');
    const limit = numberFlag(flags, 'limit', 20, { min: 0, max: 200, integer: true });
    const assert = boolFlag(flags, 'assert');
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);
      let elements;
      try {
        elements = await page.$$(selector);
      } catch (err) {
        throw mapDevtoolsError(err, { selector });
      }
      const slice = elements.slice(0, limit);
      let described;
      try {
        described = await Promise.all(
          slice.map((element) =>
            describeElement(element, { styles: parseStyles(flags), wxml: boolFlag(flags, 'wxml') }),
          ),
        );
      } catch (err) {
        throw mapDevtoolsError(err, { selector });
      }
      if (assert && elements.length === 0) {
        throw new CliError(`no elements matched: ${selector}`, {
          exitCode: EXIT.ASSERT,
          code: 'element-not-found',
        });
      }
      return { selector, count: elements.length, returned: described.length, elements: described };
    });
  },

  async probe({ config, flags, args }) {
    const spec = flags.spec !== undefined ? parseJsonArg(flags.spec, '--spec') : { selector: requireArg(args, 0, 'selector') };
    validateNativeProbeOptions(spec);
    return withSession(config, flags, async session => {
      const snapshot = await nativeProbe(session.mp, spec);
      return { exitCode: snapshot.status === 'passed' ? EXIT.OK : EXIT.ASSERT,
        code: snapshot.status === 'unsupported' ? 'unverified-native-probe' : 'native-probe-failed', data: snapshot };
    });
  },

  async 'assert-nodes'({ config, flags }) {
    if (flags.spec === undefined) throw configError('assert-nodes needs --spec @file', 'missing-arg');
    const spec = parseJsonArg(flags.spec, '--spec');
    if (!spec || !spec.probe || !spec.assert) throw configError('assert-nodes spec requires probe and assert objects', 'bad-spec');
    validateNativeProbeOptions(spec.probe);
    validateNativeNodesSpec(spec.assert);
    return withSession(config, flags, async session => {
      const snapshot = await nativeProbe(session.mp, spec.probe);
      const assessment = assessNativeNodes(snapshot, spec.assert);
      return { exitCode: assessment.status === 'passed' ? EXIT.OK : EXIT.ASSERT,
        code: assessment.status === 'unsupported' ? 'unverified-native-assertion' : 'native-assertion-failed',
        data: { snapshot, assessment } };
    });
  },

  async ready({ config, flags }) {
    if (flags.spec === undefined) throw configError('ready needs --spec @file', 'missing-arg');
    const spec = validateReadyAdapterSpec(parseJsonArg(flags.spec, '--spec'));
    return withSession(config, flags, async session => {
      const result = await readyFor(session.mp, spec);
      return { exitCode: result.status === 'passed' ? EXIT.OK : EXIT.ASSERT,
        code: 'readiness-timeout', data: result };
    });
  },

  async swipe({ config, flags, args }) {
    const selector = requireArg(args, 0, 'selector');
    if (flags.spec === undefined) throw configError('swipe needs --spec @file with viewport from/to coordinates', 'missing-arg');
    const spec = parseJsonArg(flags.spec, '--spec');
    return withSession(config, flags, async session => {
      const page = await currentPageOrThrow(session.mp);
      const chosen = await chooseElement(await queryRoot(page, stringFlag(flags, 'within')), selector,
        { index: numberFlag(flags, 'index', null, { integer: true, min: 0 }), strict: true });
      const result = await attemptSwipe(session.mp, chosen.element, { ...spec, selector });
      // SDK dispatch can move app state but cannot certify OS/native input or real inertia.
      return { exitCode: EXIT.ASSERT, code: 'gesture-unverified', data: { ...result, status: 'uncovered' } };
    });
  },

  async 'scroll-observe'({ config, flags }) {
    const spec = flags.spec === undefined ? {} : parseJsonArg(flags.spec, '--spec');
    return withSession(config, flags, async session => {
      const result = await observeScroll(session.mp, spec);
      return { exitCode: result.status === 'passed' ? EXIT.OK : EXIT.ASSERT,
        code: 'scroll-coverage-unverified', data: result };
    });
  },

  async 'find-text'({ config, flags, args }) {
    const text = String(requireArg(args, 0, 'text')).trim();
    if (!text) {
      throw new CliError('find-text needs a non-empty text query', {
        exitCode: EXIT.CONFIG,
        code: 'missing-arg',
      });
    }
    const exact = boolFlag(flags, 'exact');
    const tag = stringFlag(flags, 'tag');
    const limit = numberFlag(flags, 'limit', 20, { min: 1, max: 100, integer: true });
    const assert = boolFlag(flags, 'assert');
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);
      const scan = await textMatches(await queryRoot(page, stringFlag(flags, 'within')), text, { exact, tag });
      const matches = scan.matches;
      if (assert && matches.length === 0) {
        throw new CliError(`no element text matched: ${text}`, {
          exitCode: EXIT.ASSERT,
          code: 'element-not-found',
          data: { text, exact, tag },
        });
      }
      const slice = matches.slice(0, limit);
      return {
        text,
        exact,
        tag,
        count: matches.length,
        returned: slice.length,
        scan: { scanned: scan.scanned, incomplete: scan.incomplete, maxScanned: scan.maxScanned },
        truncated: scan.incomplete || slice.length < matches.length,
        matches: slice.map(describeTextMatch),
      };
    });
  },

  async 'tap-text'({ config, flags, args }) {
    const text = String(requireArg(args, 0, 'text')).trim();
    if (!text) {
      throw new CliError('tap-text needs a non-empty text query', {
        exitCode: EXIT.CONFIG,
        code: 'missing-arg',
      });
    }
    const exact = boolFlag(flags, 'exact');
    const tag = stringFlag(flags, 'tag');
    const index = numberFlag(flags, 'index', null, { min: 0, max: 1000, integer: true });
    const waitMs = numberFlag(flags, 'wait-ms', 500, { min: 0, max: 60000 });
    const waitSelector = stringFlag(flags, 'wait-for');
    const waitGone = boolFlag(flags, 'wait-gone');
    if (waitGone && !waitSelector) {
      throw new CliError('--wait-gone needs --wait-for <selector>', {
        exitCode: EXIT.CONFIG,
        code: 'missing-arg',
      });
    }
    const waitTimeout = numberFlag(flags, 'wait-timeout', 5000, { min: 1, max: 600000 });
    const waitInterval = numberFlag(flags, 'interval', 100, { min: 10, max: 5000 });
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);
      const strict = boolFlag(flags, 'strict');
      const scan = await textMatches(await queryRoot(page, stringFlag(flags, 'within')), text, { exact: exact || strict, tag });
      const target = selectTextMatch(scan, { index, strict, query: text });
      const match = target.match;
      const before = await describeElement(match.element);
      await match.element.tap();
      await sleep(waitMs);
      const after = await session.mp.currentPage();
      const waited = waitSelector
        ? await waitForSelector(() => session.mp.currentPage(), waitSelector, {
            gone: waitGone,
            timeoutMs: waitTimeout,
            interval: waitInterval,
          })
        : null;
      return {
        text,
        index,
        exact,
        tag,
        matched: describeTextMatch(match),
        strict,
        matchCount: target.count,
        warning: target.warning,
        eventSent: true,
        businessVerified: false,
        tapped: true,
        before,
        page: after ? after.path : null,
        waitFor: waited,
      };
    });
  },

  async 'wait-for'({ config, flags, args }) {
    const selector = args[0] ?? stringFlag(flags, 'selector');
    if (!selector) {
      throw new CliError('wait-for needs a selector', {
        exitCode: EXIT.CONFIG,
        code: 'missing-arg',
      });
    }
    const timeoutMs = numberFlag(flags, 'wait-timeout', 5000, { min: 1, max: 600000 });
    const interval = numberFlag(flags, 'interval', 100, { min: 10, max: 5000 });
    const gone = boolFlag(flags, 'gone');
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);
      return waitForSelector(() => session.mp.currentPage(), selector, { gone, timeoutMs, interval });
    });
  },

  async tap({ config, flags, args }) {
    const selector = requireArg(args, 0, 'selector');
    const index = numberFlag(flags, 'index', null, { min: 0, max: 10000, integer: true });
    const waitMs = numberFlag(flags, 'wait-ms', 500, { min: 0, max: 60000 });
    const waitSelector = stringFlag(flags, 'wait-for');
    const waitGone = boolFlag(flags, 'wait-gone');
    if (waitGone && !waitSelector) {
      throw new CliError('--wait-gone needs --wait-for <selector>', {
        exitCode: EXIT.CONFIG,
        code: 'missing-arg',
      });
    }
    const waitTimeout = numberFlag(flags, 'wait-timeout', 5000, { min: 1, max: 600000 });
    const waitInterval = numberFlag(flags, 'interval', 100, { min: 10, max: 5000 });
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);
      const target = await chooseElement(await queryRoot(page, stringFlag(flags, 'within')), selector,
        { index, strict: boolFlag(flags, 'strict') });
      const element = target.element;
      const before = await describeElement(element);
      await element.tap();
      await sleep(waitMs);
      const after = await session.mp.currentPage();
      const waited = waitSelector
        ? await waitForSelector(() => session.mp.currentPage(), waitSelector, {
            gone: waitGone,
            timeoutMs: waitTimeout,
            interval: waitInterval,
          })
        : null;
      return {
        selector,
        index,
        tapped: true,
        eventSent: true,
        businessVerified: false,
        matchCount: target.count,
        warning: target.warning,
        before,
        page: after ? after.path : null,
        waitFor: waited,
      };
    });
  },

  async input({ config, flags, args }) {
    const selector = requireArg(args, 0, 'selector');
    const index = numberFlag(flags, 'index', null, { min: 0, max: 10000, integer: true });
    const flagValue = stringFlag(flags, 'value', null, { allowEmpty: true });
    const value = flagValue === null ? requireArg(args, 1, 'value') : flagValue;
    const waitMs = numberFlag(flags, 'wait-ms', 300, { min: 0, max: 60000 });
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);
      const target = await chooseElement(await queryRoot(page, stringFlag(flags, 'within')), selector,
        { index, strict: boolFlag(flags, 'strict') });
      const element = target.element;
      if (typeof element.input !== 'function') {
        throw new CliError(
          `element "${selector}" is <${element.tagName}>, not an input/textarea; use trigger or tap instead`,
          { exitCode: EXIT.ASSERT, code: 'element-not-input' },
        );
      }
      await element.input(value);
      await sleep(waitMs);
      const triggered = [];
      if (boolFlag(flags, 'confirm')) {
        await element.trigger('confirm', { value });
        triggered.push('confirm');
      }
      if (boolFlag(flags, 'blur')) {
        await element.trigger('blur', { value });
        triggered.push('blur');
      }
      let actual = null;
      try {
        actual = await element.value();
      } catch {
        /* some custom inputs do not expose value() */
      }
      return { selector, index, value, actual, triggered, ok: true };
    });
  },

  async trigger({ config, flags, args }) {
    const selector = requireArg(args, 0, 'selector');
    const index = numberFlag(flags, 'index', null, { min: 0, max: 10000, integer: true });
    const type = stringFlag(flags, 'type', 'tap');
    const detail = flags.detail !== undefined ? parseJsonArg(flags.detail, '--detail') : undefined;
    const waitMs = numberFlag(flags, 'wait-ms', 400, { min: 0, max: 60000 });
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);
      const target = await chooseElement(await queryRoot(page, stringFlag(flags, 'within')), selector,
        { index, strict: boolFlag(flags, 'strict') });
      const element = target.element;
      await element.trigger(type, detail);
      await sleep(waitMs);
      return { selector, index, type, ok: true };
    });
  },

  async scroll({ config, flags }) {
    const top = numberFlag(flags, 'top', 0, { min: 0, max: 10_000_000 });
    const selector = stringFlag(flags, 'selector');
    const index = numberFlag(flags, 'index', null, { min: 0, max: 10000, integer: true });
    const waitMs = numberFlag(flags, 'wait-ms', 300, { min: 0, max: 60000 });
    return withSession(config, flags, async (session) => {
      const page = await currentPageOrThrow(session.mp);

      if (selector) {
        const element = await findElementOrThrow(page, selector, index);
        if (typeof element.scrollTo !== 'function') {
          throw new CliError(
            `element "${selector}" is <${element.tagName}>, not a scroll-view; omit --selector to use pageScrollTo`,
            { exitCode: EXIT.ASSERT, code: 'element-not-scrollable' },
          );
        }
        await element.scrollTo(0, top);
        await sleep(waitMs);
        const actual = await pollScroll(async () => {
          try {
            const raw = await element.property('scrollTop');
            if (raw === null || raw === undefined || raw === '') return null;
            const value = Number(raw);
            return Number.isFinite(value) ? value : null;
          } catch {
            return null;
          }
        }, top);
        if (!Number.isFinite(actual)) {
          throw new CliError('scroll dispatched but native offset could not be verified', {
            exitCode: EXIT.ASSERT, code: 'scroll-unverified',
            data: { selector, top, actualTop: null, interaction: 'programmatic-scroll', uncovered: ['offset-verification', 'physical-gesture', 'post-release-inertia'] },
          });
        }
        if (Number.isFinite(actual) && Math.abs(actual - top) > 1) {
          throw new CliError(
            `scroll-view "${selector}" did not reach ${top} (actual ${actual})`,
            { exitCode: EXIT.ASSERT, code: 'scroll-no-effect' },
          );
        }
        return { selector, index, top, actualTop: Number.isFinite(actual) ? actual : null, mode: 'scroll-view',
          interaction: 'programmatic-scroll', physicalGestureVerified: false,
          uncovered: ['physical-gesture', 'post-release-inertia'], ok: Number.isFinite(actual),
          verification: Number.isFinite(actual) ? 'measured-offset' : 'unverified-offset' };
      }

      const before = await pageScrollTop(page);
      await session.mp.pageScrollTo(top);
      await sleep(waitMs);
      const after = await pollScroll(() => pageScrollTop(page), top);
      if (!Number.isFinite(after)) {
        throw new CliError('page scroll dispatched but native offset could not be verified', {
          exitCode: EXIT.ASSERT, code: 'scroll-unverified',
          data: { top, actualTop: null, interaction: 'programmatic-scroll', uncovered: ['offset-verification', 'physical-gesture', 'post-release-inertia'] },
        });
      }
      if (Number.isFinite(after) && Math.abs(after - top) > 1) {
        throw new CliError(
          `pageScrollTo did not reach ${top} (actual ${after}). ` +
            `If the content lives in a scroll-view, retry with --selector "<scroll-view selector>".`,
          {
            exitCode: EXIT.ASSERT,
            code: 'scroll-no-effect',
            data: { top, before, actualTop: after },
          },
        );
      }
      return {
        top,
        before,
        actualTop: Number.isFinite(after) ? after : null,
        mode: 'page',
        interaction: 'programmatic-scroll',
        physicalGestureVerified: false,
        uncovered: ['physical-gesture', 'post-release-inertia'],
        verification: Number.isFinite(after) ? 'measured-offset' : 'unverified-offset',
        ok: Number.isFinite(after),
      };
    });
  },

  async shot({ config, flags }) {
    const cwd = process.cwd();
    const out = stringFlag(flags, 'out');
    const selector = stringFlag(flags, 'selector');
    const index = numberFlag(flags, 'index', null, { min: 0, max: 10000, integer: true });
    const pad = numberFlag(flags, 'pad', 0, { min: 0, max: 1000 });
    const baseline = stringFlag(flags, 'baseline');
    const mask = stringFlag(flags, 'mask');
    const threshold = numberFlag(flags, 'threshold', 0.1, { min: 0, max: 100 });
    const pixelThreshold = numberFlag(flags, 'pixel-threshold', 0.1, { min: 0, max: 1 });
    const updateBaseline = boolFlag(flags, 'update-baseline');
    const label = stringFlag(flags, 'label');
    const settleMs = numberFlag(flags, 'settle-ms', 0, { min: 0, max: 60000 });
    const shotTimeout = numberFlag(flags, 'shot-timeout', 15000, { min: 1, max: 300000, allowZero: false });
    return withSession(config, flags, async (session) =>
      captureShot(session, {
        cwd,
        outPath: out ? path.resolve(cwd, out) : undefined,
        selector,
        index,
        pad,
        baseline,
        mask,
        threshold,
        pixelThreshold,
        updateBaseline,
        label,
        settleMs,
        shotTimeout,
      }),
    );
  },

  async mock({ config, flags, args }) {
    const api = normalizeWxApi(requireArg(args, 0, 'wxApi'));
    const raw = args[1] ?? flags.value ?? flags.fn;
    if (raw === undefined) {
      throw new CliError('mock needs a JSON result (or --fn <body>)', {
        exitCode: EXIT.CONFIG,
        code: 'missing-arg',
      });
    }
    let payload;
    let mode = 'value';
    if (flags.fn !== undefined) {
      const body = readTextArg(String(flags.fn), '--fn');
      try {
        payload = new Function(body);
      } catch (err) {
        throw new CliError(`--fn is not a valid function body: ${err.message}`, {
          exitCode: EXIT.CONFIG,
          code: 'bad-fn',
        });
      }
      mode = 'function';
    } else {
      payload = parseJsonArg(raw, 'mock payload');
    }
    return withSession(config, flags, async (session) => {
      try {
        await session.mp.mockWxMethod(api, payload);
      } catch (err) {
        const mapped = mapDevtoolsError(err);
        const exitCode =
          mapped.exitCode === EXIT.UNREACHABLE
            ? EXIT.UNREACHABLE
            : mapped.exitCode === EXIT.CONFIG
              ? EXIT.CONFIG
              : EXIT.RUNTIME;
        throw new CliError(`mock failed for "${api}": ${mapped.message}`, {
          exitCode,
          code: 'mock-failed',
        });
      }
      return { api, mode, ok: true };
    });
  },

  async restore({ config, flags, args }) {
    const api = normalizeWxApi(requireArg(args, 0, 'wxApi'));
    return withSession(config, flags, async (session) => {
      try {
        await session.mp.restoreWxMethod(api);
      } catch (err) {
        const mapped = mapDevtoolsError(err);
        const exitCode =
          mapped.exitCode === EXIT.UNREACHABLE
            ? EXIT.UNREACHABLE
            : mapped.exitCode === EXIT.CONFIG
              ? EXIT.CONFIG
              : EXIT.RUNTIME;
        throw new CliError(`restore failed for "${api}": ${mapped.message}`, {
          exitCode,
          code: 'restore-failed',
        });
      }
      return { api, restored: true };
    });
  },

  async audit({ config, flags, args }) {
    const sub = args[0] ?? 'report';
    if (sub !== 'report' && sub !== 'stop') {
      throw new CliError(
        `audit only stops/reports an audit; "${sub}" is not supported. Start 体验评分 in DevTools, then run audit.`,
        { exitCode: EXIT.CONFIG, code: 'bad-action' },
      );
    }
    const cwd = process.cwd();
    const out = stringFlag(flags, 'out');
    return withSession(config, flags, async (session) => {
      let outPath = out ? path.resolve(cwd, out) : null;
      if (outPath) {
        validateArtifactPath(outPath);
        try {
          if (fs.statSync(outPath).isDirectory()) {
            throw new CliError(`--out must be a file, got a directory: ${outPath}`, {
              exitCode: EXIT.CONFIG,
              code: 'bad-out',
            });
          }
        } catch (err) {
          if (err instanceof CliError) throw err;
        }
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
      }
      let report;
      try {
        report = await session.mp.stopAudits(outPath ? { path: outPath } : {});
      } catch (err) {
        throw mapDevtoolsError(err);
      }
      return { out: outPath, report };
    });
  },

  async native({ config, flags, args }) {
    const action = requireArg(args, 0, 'action');
    let payload;
    if (flags.data !== undefined && flags.url !== undefined) {
      throw new CliError('native accepts either --data or --url, not both', {
        exitCode: EXIT.CONFIG,
        code: 'bad-flag',
      });
    }
    if (flags.data !== undefined) {
      payload = parseJsonArg(flags.data, '--data');
    } else if (flags.url !== undefined) {
      payload = { url: stringFlag(flags, 'url') };
    }
    return withSession(config, flags, async (session) => {
      const nativeApi = session.mp.native();
      const methods = nativeMethods(nativeApi);
      if (!methods.includes(action)) {
        throw new CliError(
          `unknown native action: ${action}. Available: ${methods.join(', ')}`,
          { exitCode: EXIT.CONFIG, code: 'bad-action' },
        );
      }
      if (action === 'switchTab' && payload === undefined) {
        throw new CliError('native switchTab needs --url <tabBar page> or --data \'{"url":"..."}\'', {
          exitCode: EXIT.CONFIG,
          code: 'missing-arg',
        });
      }
      const result = payload === undefined ? await nativeApi[action]() : await nativeApi[action](payload);
      await sleep(500);
      if (result && typeof result === 'object' && result.error) {
        throw new CliError(
          `native ${action} failed: ${result.error.message ?? JSON.stringify(result.error)}`,
          {
            exitCode: EXIT.ASSERT,
            code: 'native-failed',
            data: { action, result },
          },
        );
      }
      return { action, result };
    });
  },

  async ticket({ config, flags, args }) {
    const action = requireArg(args, 0, 'get|set|refresh');
    return withSession(config, flags, async (session) => {
      if (action === 'get') {
        return { ticket: await session.mp.getTicket() };
      }
      if (action === 'set') {
        const value = requireArg(args, 1, 'ticket');
        await session.mp.setTicket(value);
        return { ticket: value, set: true };
      }
      if (action === 'refresh') {
        if (typeof session.mp.refreshTicket !== 'function') {
          throw new CliError('this automator version does not support refreshTicket', {
            exitCode: EXIT.CONFIG,
            code: 'unsupported',
          });
        }
        await session.mp.refreshTicket();
        return { refreshed: true };
      }
      throw new CliError(`ticket expects get|set|refresh, got: ${action}`, {
        exitCode: EXIT.CONFIG,
        code: 'bad-action',
      });
    });
  },

  async run({ config, flags, args }) {
    const cwd = process.cwd();
    const file = path.resolve(cwd, requireArg(args, 0, 'script'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new CliError(`script not found: ${file}`, { exitCode: EXIT.CONFIG, code: 'no-script' });
    }
    const requestedRunTimeout = numberFlag(flags, 'run-timeout', 600000, {
      min: 0,
      max: 86_400_000,
    });
    const globalTimeout = numberFlag(flags, 'timeout', 0, { min: 0, max: 86_400_000 });
    const limits = [requestedRunTimeout, globalTimeout].filter(value => value > 0);
    const runTimeout = limits.length ? Math.min(...limits) : 0;
    const keepMocks = boolFlag(flags, 'keep-mocks');
    const shotTimeout = numberFlag(flags, 'shot-timeout', 15000, { min: 1, max: 300000, allowZero: false });
    return withSession(config, flags, async (session) => {
      const page = await session.mp.currentPage();
      if (flags.evidence !== undefined) session.evidence.declare(parseJsonArg(flags.evidence, '--evidence'));
      const mockedWx = new Set();
      const mockedPlugin = new Map();
      const cleanup = { kept: keepMocks, mockedWx: [], mockedPlugin: [], failed: [] };
      const controller = new AbortController();
      flags.__abortRun = controller;
      let exitCode = EXIT.OK;
      let caughtError = null;
      const originalConsoleLog = console.log;
      const originalConsoleInfo = console.info;
      console.log = (...args) => log('[script]', ...args);
      console.info = console.log;
      const originalMockWx = session.mp.mockWxMethod.bind(session.mp);
      const originalRestoreWx = session.mp.restoreWxMethod.bind(session.mp);
      const originalMockPlugin =
        typeof session.mp.mockPluginWxMethod === 'function'
          ? session.mp.mockPluginWxMethod.bind(session.mp)
          : null;
      const originalRestorePlugin =
        typeof session.mp.restorePluginWxMethod === 'function'
          ? session.mp.restorePluginWxMethod.bind(session.mp)
          : null;

      // Track mocks so a failed script cannot poison the next CLI call. The
      // standalone `mock` command intentionally stays cross-process.
      session.mp.mockWxMethod = async (method, result, ...extra) => {
        session.evidence.report.dataSource = ['real-service', 'synthetic', 'mixed'].includes(session.evidence.report.dataSource) ? 'mixed' : 'mocked';
        mockedWx.add(method);
        return originalMockWx(method, result, ...extra);
      };
      session.mp.restoreWxMethod = async (method) => {
        await originalRestoreWx(method);
        mockedWx.delete(method);
      };
      if (originalMockPlugin && originalRestorePlugin) {
        session.mp.mockPluginWxMethod = async (pluginId, method, result, ...extra) => {
          session.evidence.report.dataSource = ['real-service', 'synthetic', 'mixed'].includes(session.evidence.report.dataSource) ? 'mixed' : 'mocked';
          mockedPlugin.set(`${pluginId}\0${method}`, { pluginId, method });
          return originalMockPlugin(pluginId, method, result, ...extra);
        };
        session.mp.restorePluginWxMethod = async (pluginId, method) => {
          await originalRestorePlugin(pluginId, method);
          mockedPlugin.delete(`${pluginId}\0${method}`);
        };
      }

      const restoreMethods = () => {
        delete session.mp.mockWxMethod;
        delete session.mp.restoreWxMethod;
        if (originalMockPlugin && originalRestorePlugin) {
          delete session.mp.mockPluginWxMethod;
          delete session.mp.restorePluginWxMethod;
        }
      };

      const context = {
        mp: session.mp,
        mode: session.mode,
        config,
        flags,
        page: () => { controller.signal.throwIfAborted(); return session.mp.currentPage(); },
        currentPage: page,
        log,
        sleep,
        sanitize,
        signal: controller.signal,
        step: (name, fn, options) => session.diagnostics.step(name, async () => {
          controller.signal.throwIfAborted();
          return fn();
        }, options),
        evidence: value => session.evidence.declare(value),
        recordInteraction: (method, detail) => session.evidence.record(method, { ...detail, source: 'script-declared' }),
        probe: async options => { controller.signal.throwIfAborted(); return nativeProbe(session.mp, options); },
        assertNodes: async (options, assertions) => {
          controller.signal.throwIfAborted();
          const snapshot = await nativeProbe(session.mp, options);
          const assessment = assessNativeNodes(snapshot, assertions);
          if (assessment.status !== 'passed') throw new CliError('native nodes did not satisfy the rendered-state assertion', {
            exitCode: EXIT.ASSERT, code: assessment.status === 'unsupported' ? 'unverified-native-assertion' : 'native-assertion-failed',
            data: { snapshot, assessment },
          });
          return { snapshot, assessment };
        },
        ready: async spec => {
          controller.signal.throwIfAborted();
          const result = await readyFor(session.mp, spec, { signal: controller.signal });
          if (result.status !== 'passed') throw new CliError('combined readiness was not reached', { exitCode: EXIT.ASSERT, code: 'readiness-timeout', data: result });
          return result;
        },
        observeScroll: options => observeScroll(session.mp, { ...options, signal: controller.signal }),
        swipe: async (selector, options = {}) => {
          controller.signal.throwIfAborted();
          const current = await currentPageOrThrow(session.mp);
          const chosen = await chooseElement(await queryRoot(current, options.within), selector, { index: options.index ?? null, strict: true });
          session.evidence.record('sdk-touch-events', { selector, source: 'ctx.swipe' });
          const result = await attemptSwipe(session.mp, chosen.element, { ...options, selector, signal: controller.signal });
          return { ...result, status: 'uncovered' };
        },
        shot: async (outPath, options = {}) => {
          controller.signal.throwIfAborted();
          if (typeof outPath !== 'string' || !outPath) {
            throw new CliError('shot needs an output path', {
              exitCode: EXIT.CONFIG,
              code: 'missing-arg',
            });
          }
          const current = (await session.mp.currentPage()) ?? page;
          if (!current) {
            throw new CliError('devtools reported no current page', {
              exitCode: EXIT.UNREACHABLE,
              code: 'no-page',
            });
          }
          const pad = options.pad ?? 0;
          const settleMs = options.settleMs ?? 0;
          const threshold = options.threshold ?? 0.1;
          const pixelThreshold = options.pixelThreshold ?? 0.1;
          for (const [name, value, min, max] of [
            ['pad', pad, 0, 1000],
            ['settleMs', settleMs, 0, 60000],
            ['threshold', threshold, 0, 100],
            ['pixelThreshold', pixelThreshold, 0, 1],
          ]) {
            if (!Number.isFinite(value) || value < min || value > max) {
              throw new CliError(`shot option ${name} must be between ${min} and ${max}`, {
                exitCode: EXIT.CONFIG,
                code: 'bad-number',
              });
            }
          }
          const result = await captureShot(session, {
            cwd,
            outPath: path.resolve(cwd, outPath),
            selector: options.selector,
            index: options.index ?? null,
            pad,
            baseline: options.baseline,
            mask: options.mask,
            threshold,
            pixelThreshold,
            updateBaseline: Boolean(options.updateBaseline),
            label: options.label ?? null,
            settleMs,
            shotTimeout,
          });
          if (result.exitCode !== EXIT.OK) {
            throw new CliError(`visual mismatch for ${outPath}`, {
              exitCode: result.exitCode,
              code: 'visual-mismatch',
              data: result.data,
            });
          }
          return result.data;
        },
        assert: (condition, message) => {
          if (!condition) {
            throw new CliError(message ?? 'assertion failed', {
              exitCode: EXIT.ASSERT,
              code: 'assert',
            });
          }
          return true;
        },
      };

      let payload = null;
      try {
        let mod;
        try {
          mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
        } catch (err) {
          throw new CliError(`cannot load ${file}: ${err.message}`, {
            exitCode: EXIT.CONFIG,
            code: 'bad-script',
          });
        }
        const fn = mod.default ?? mod.run;
        if (typeof fn !== 'function') {
          throw new CliError(`${file} must export default or named run(ctx)`, {
            exitCode: EXIT.CONFIG,
            code: 'bad-script',
          });
        }
        const result =
          runTimeout > 0
            ? await withTimeout(Promise.resolve(fn(context)), runTimeout, 'run script')
            : await fn(context);
        payload = { script: file, result: result ?? null, cleanup, steps: session.diagnostics.steps };
      } catch (err) {
        let finalError =
          err instanceof CliError && err.code === 'timeout' && err.exitCode === EXIT.UNREACHABLE
            ? new CliError(`run script timed out after ${runTimeout}ms`, {
                exitCode: EXIT.RUNTIME,
                code: 'run-timeout',
              })
            : err;
        if (finalError instanceof CliError && finalError.code === 'run-timeout') {
          controller.abort(new Error('run-timeout'));
        }
        if (!(finalError instanceof CliError)) finalError = new CliError(finalError?.message ?? String(finalError), {
          exitCode: finalError?.exitCode ?? EXIT.RUNTIME, code: finalError?.code ?? 'script-failed',
        });
        if (!controller.signal.aborted) controller.abort(finalError);
        if (finalError.exitCode !== EXIT.CONFIG) {
          const diagnostics = await session.diagnostics.capture(finalError);
          finalError.data = { ...(finalError.data && typeof finalError.data === 'object' ? finalError.data : {}), diagnostics };
        }
        caughtError = finalError;
        throw finalError;
      } finally {
        console.log = originalConsoleLog;
        console.info = originalConsoleInfo;
        if (!keepMocks) {
          for (const method of mockedWx) {
            cleanup.mockedWx.push(method);
            try {
              await originalRestoreWx(method);
            } catch (err) {
              cleanup.failed.push({ kind: 'wx', method, message: err.message });
              log(`[weapp] mock cleanup warning (${method}): ${err.message}`);
            }
          }
          for (const { pluginId, method } of mockedPlugin.values()) {
            cleanup.mockedPlugin.push(`${pluginId}/${method}`);
            try {
              await originalRestorePlugin(pluginId, method);
            } catch (err) {
              cleanup.failed.push({ kind: 'plugin', pluginId, method, message: err.message });
              log(`[weapp] plugin mock cleanup warning (${pluginId}/${method}): ${err.message}`);
            }
          }
        }
        if (caughtError instanceof CliError) {
          caughtError.data = {
            ...(caughtError.data && typeof caughtError.data === 'object' ? caughtError.data : {}),
            cleanup,
          };
        }
        if (cleanup.failed.length > 0) {
          exitCode = EXIT.RUNTIME;
        }
        restoreMethods();
      }
      return {
        exitCode,
        ...(exitCode === EXIT.OK
          ? {}
          : { code: 'cleanup-failed', message: 'mock cleanup failed' }),
        data: payload,
        steps: session.diagnostics.steps,
      };
    });
  },

  async lock({ config, flags, args }) {
    const action = args[0] ?? 'status';
    const port = config.port;
    const file = lockPath(port);
    if (action === 'clear') {
      const info = readLockInfo(port);
      if (info?.alive && !boolFlag(flags, 'force')) {
        throw new CliError(
          `lock for port ${port} is held by live pid ${info.pid}; use "lock clear --force" only if you are sure it is orphaned`,
          {
            exitCode: EXIT.UNREACHABLE,
            code: 'busy',
            data: {
              port,
              file,
              pid: info.pid,
              ageMs: info.age,
              command: info.command,
              cwd: info.cwd,
            },
          },
        );
      }
      let removed = false;
      try {
        fs.unlinkSync(file);
        removed = true;
      } catch {
        removed = false;
      }
      return {
        port,
        file,
        removed,
        holder: info?.body ?? null,
        pid: info?.pid ?? null,
      };
    }
    if (action !== 'status') {
      throw new CliError(`lock expects status|clear, got: ${action}`, {
        exitCode: EXIT.CONFIG,
        code: 'bad-action',
      });
    }
    const info = readLockInfo(port);
    return {
      port,
      file,
      holder: info?.body ?? null,
      pid: info?.pid ?? null,
      alive: info?.alive ?? false,
      stale: info?.stale ?? true,
      ageMs: info?.age ?? null,
      command: info?.command ?? null,
      cwd: info?.cwd ?? null,
      startedAt: info?.startedAt ?? null,
    };
  },
};

/* ---------------------------------------------------------------------- main */

function fallbackConfig(err) {
  return {
    projectPath: null,
    cliPath: null,
    port: 9420,
    sources: {},
    configFile: null,
    warnings: [err?.message ?? String(err)],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const startedAt = Date.now();
  const raw = argv;
  const { positional, flags } = parseArgs(raw);
  const wantsHelp = flags.help === true || flags.help === 'true' || flags.help === '1';
  const cmd = wantsHelp ? 'help' : (positional[0] ?? 'help');
  const args = positional.slice(1);

  let config;
  let configurationError = null;
  try {
    config = resolveConfig(flags);
  } catch (err) {
    config = fallbackConfig(err);
    configurationError = err;
  }

  const meta = {
    port: config.port,
    project: config.projectPath,
    miniprogramRoot: config.miniprogramRoot ?? null,
    appid: config.appid ?? null,
    devtools: config.cliPath,
    packageRoot: PACKAGE_ROOT,
    version: PACKAGE.version,
  };

  let resultOut = null;
  const sendEnvelope = async envelope => {
    const prepared = await prepareEnvelope(envelope, resultOut ? { resultOut } : {});
    await emitAsync(prepared);
  };
  const handler = commands[cmd];
  if (!handler) {
    await sendEnvelope({
      ok: false,
      cmd,
      data: null,
      error: { code: 'unknown-command', message: `unknown command: ${cmd}. Run "weapp help".` },
      meta: { ...meta, durationMs: Date.now() - startedAt, available: Object.keys(commands) },
    });
    process.exit(EXIT.CONFIG);
  }

  try {
    if (configurationError && cmd !== 'help') throw configurationError;
    validateFlags(flags);
    const requestedResultOut = stringFlag(flags, 'result-out');
    if (requestedResultOut) {
      // Arm output only after physical-path validation (junction-safe).
      resultOut = validateResultPath(requestedResultOut, PACKAGE_ROOT);
    }
    const timeoutMs = numberFlag(flags, 'timeout', 0, { min: 0, max: 86_400_000 });
    const result = await withTimeout(
      Promise.resolve(handler({ config, flags, args, cmd })),
      cmd === 'run' ? 0 : timeoutMs,
      cmd,
    );
    const payload =
      result && typeof result === 'object' && ('data' in result || 'exitCode' in result)
        ? result
        : { data: result };
    const exitCode = payload.exitCode ?? EXIT.OK;
    const ok = exitCode === EXIT.OK;
    await sendEnvelope({
      ok,
      cmd,
      data: payload.data ?? null,
      ...(ok
        ? {}
        : {
            error: {
              code: payload.code ?? (exitCode === EXIT.ASSERT ? 'assertion-failed' : 'command-failed'),
              message:
                payload.message ??
                (exitCode === EXIT.ASSERT ? 'assertion failed' : `command exited with code ${exitCode}`),
            },
          }),
      meta: { ...meta, durationMs: Date.now() - startedAt, evidence: payload.evidence ?? flags.__evidence ?? null },
    });
    process.exit(exitCode);
  } catch (err) {
    const cliError = err instanceof CliError ? err : mapDevtoolsError(err);
    if (cliError.code === 'result-out-failed' || cliError.code === 'bad-output-path') resultOut = null;
    if (!(err instanceof CliError) && err?.stack) log(err.stack);
    if (cliError.code === 'timeout') {
      flags.__abortRun?.abort(new Error('global-timeout'));
      const diagnostics = await flags.__diagnostics?.capture(cliError);
      if (diagnostics) cliError.data = { ...(cliError.data && typeof cliError.data === 'object' ? cliError.data : {}), diagnostics };
    }
    const envelope = {
      ok: false,
      cmd,
      data: cliError.data ?? null,
      error: { code: cliError.code, message: cliError.message },
      meta: { ...meta, durationMs: Date.now() - startedAt, evidence: flags.__evidence ?? null },
    };
    try { await sendEnvelope(envelope); }
    catch (writeError) {
      resultOut = null;
      envelope.error = { code: writeError.code ?? 'result-out-failed', message: writeError.message };
      await sendEnvelope(envelope);
      process.exit(EXIT.RUNTIME);
    }
    process.exit(cliError.exitCode);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log(`[weapp] fatal: ${err?.stack ?? err}`);
    process.exit(EXIT.RUNTIME);
  });
}
