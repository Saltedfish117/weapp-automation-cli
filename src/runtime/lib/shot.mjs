/**
 * Screenshot capture, element cropping and baseline pixel comparison.
 *
 * Reality checks encoded here:
 *  - App.captureScreenshot returns the simulator viewport only (no devtools chrome),
 *    at 1x CSS pixels, so element crops use CSS coordinates directly.
 *  - There is no element-scoped screenshot API: crop yourself.
 *  - Element.offset() is viewport-relative (verified with a scrolled scroll-view:
 *    a child moved from top=182 to top=-18 after scrollTo(0, 200)). It must not
 *    be adjusted by page scrollTop.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { CliError, EXIT } from './output.mjs';
import { validateArtifactPath } from './result-path.mjs';

/** @returns {Promise<Buffer>} */
export async function capturePng(mp) {
  const base64 = await mp.screenshot();
  if (!base64 || typeof base64 !== 'string') {
    throw new CliError('devtools returned no screenshot payload', {
      exitCode: EXIT.RUNTIME,
      code: 'screenshot-empty',
    });
  }
  return Buffer.from(base64, 'base64');
}

/**
 * capturePng with a hard timeout and an actionable message.
 *
 * App.captureScreenshot never settles while the devtools window is minimised
 * (the simulator is not painted), so a bare await hangs forever.
 */
export async function capturePngGuarded(mp, timeoutMs = 15000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliError(`invalid screenshot timeout: ${timeoutMs}`, {
      exitCode: EXIT.CONFIG,
      code: 'bad-shot-timeout',
    });
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new CliError(
          `screenshot timed out after ${timeoutMs}ms. The WeChat DevTools window is probably minimised (the simulator is not painted) - restore it and retry, or use "up --restart" as a last resort.`,
          { exitCode: EXIT.UNREACHABLE, code: 'screenshot-timeout' },
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([capturePng(mp), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function writePng(filePath, buffer) {
  validateArtifactPath(filePath);
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return path.resolve(filePath);
}

/** Decode a PNG with a readable error instead of a pngjs stack. */
export function readPng(buffer, label = 'PNG') {
  try {
    return PNG.sync.read(buffer);
  } catch (err) {
    throw new CliError(`${label} is not a valid PNG: ${err.message}`, {
      exitCode: EXIT.CONFIG,
      code: 'bad-png',
    });
  }
}

export function imageSize(buffer, label = 'PNG') {
  const png = readPng(buffer, label);
  return { width: png.width, height: png.height };
}

/** Intersection of two {left,top,width,height} boxes, or null. */
export function intersectBox(a, b) {
  if (!a || !b) return null;
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (!(right > left) || !(bottom > top)) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** Paint rectangles (viewport CSS px) over a PNG for baseline comparison. */
export function maskPng(buffer, boxes, color = [0, 0, 0]) {
  if (!boxes || boxes.length === 0) return buffer;
  const png = readPng(buffer);
  for (const box of boxes) {
    if (!box) continue;
    const left = Math.max(0, Math.round(box.left));
    const top = Math.max(0, Math.round(box.top));
    const right = Math.min(png.width, Math.round(box.left + box.width));
    const bottom = Math.min(png.height, Math.round(box.top + box.height));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const i = (png.width * y + x) << 2;
        png.data[i] = color[0];
        png.data[i + 1] = color[1];
        png.data[i + 2] = color[2];
        png.data[i + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

/** Crop a PNG buffer with a CSS-pixel box. The box must be inside the image. */
export function cropPng(buffer, box, padding = 0) {
  const src = readPng(buffer);
  if (!box) {
    throw new CliError('crop box is missing (element has no size/offset)', {
      exitCode: EXIT.ASSERT,
      code: 'bad-crop',
    });
  }
  if (!Number.isFinite(padding) || padding < 0) {
    throw new CliError(`invalid crop padding: ${padding}`, {
      exitCode: EXIT.CONFIG,
      code: 'bad-crop',
    });
  }
  const left = Math.round(box.left - padding);
  const top = Math.round(box.top - padding);
  const width = Math.round(box.width + padding * 2);
  const height = Math.round(box.height + padding * 2);
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    left < 0 ||
    top < 0 ||
    left + width > src.width ||
    top + height > src.height
  ) {
    throw new CliError(`crop box falls outside the screenshot: ${JSON.stringify(box)}`, {
      exitCode: EXIT.ASSERT,
      code: 'bad-crop',
    });
  }
  const dst = new PNG({ width, height });
  PNG.bitblt(src, dst, left, top, width, height, 0, 0);
  return PNG.sync.write(dst);
}

/**
 * @param {Buffer} baselineBuf
 * @param {Buffer} currentBuf
 * @param {{pixelThreshold?: number}} [options]
 */
export function comparePng(baselineBuf, currentBuf, options = {}) {
  const a = readPng(baselineBuf, 'baseline');
  const b = readPng(currentBuf, 'current screenshot');
  if (a.width !== b.width || a.height !== b.height) {
    return {
      sizeMismatch: true,
      baseline: { width: a.width, height: a.height },
      current: { width: b.width, height: b.height },
      diffPixels: null,
      mismatchPct: 100,
      diffBuffer: null,
    };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: options.pixelThreshold ?? 0.1,
    includeAA: false,
  });
  const total = a.width * a.height;
  return {
    sizeMismatch: false,
    baseline: { width: a.width, height: a.height },
    current: { width: b.width, height: b.height },
    diffPixels,
    mismatchPct: Number(((diffPixels / total) * 100).toFixed(4)),
    diffBuffer: PNG.sync.write(diff),
  };
}

export function defaultShotPath(cwd, pagePath, label) {
  const safePage = String(pagePath || 'page').replace(/[^\w.-]+/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const rand = Math.random().toString(36).slice(2, 6);
  const safeLabel = label
    ? String(label)
        .replace(/[^\w.-]+/g, '_')
        .replace(/\.png$/i, '')
    : null;
  const name = safeLabel ? `${safeLabel}.png` : `${safePage}__${stamp}__${rand}.png`;
  return path.join(cwd, '.weapp-shots', name);
}
