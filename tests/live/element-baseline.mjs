import os from 'node:os';
import path from 'node:path';

/**
 * Live regression for the element-baseline bug reported on 2026-10-17:
 * a cropped baseline must be compared against a cropped current image.
 *
 * Run:
 *   $env:WEAPP_ELEMENT_SELECTOR = '.navbar-center'
 *   weapp run tests/live/element-baseline.mjs --project <compiled-root> --attach-only
 *
 * Any selector that exists on the current page works; it should be stable
 * for the two consecutive captures.
 */
export default async (ctx) => {
  const selector = process.env.WEAPP_ELEMENT_SELECTOR || '.navbar-center';
  const directory = process.env.WEAPP_ELEMENT_OUTPUT_DIR || os.tmpdir();
  const out = path.join(directory, 'weapp-element-live.png');
  const baseline = path.join(directory, 'weapp-element-live-base.png');

  const first = await ctx.shot(out, {
    selector,
    baseline,
    updateBaseline: true,
  });
  const second = await ctx.shot(out, {
    selector,
    baseline,
  });
  ctx.assert(second.baseline && second.baseline.passed, 'element baseline comparison must pass');
  ctx.assert(
    second.cropped && second.cropped.viewport && second.viewport,
    'shot must expose the full-page viewport',
  );

  return {
    selector,
    first: { bytes: first.bytes, cropped: first.cropped, viewport: first.viewport },
    second: { bytes: second.bytes, baseline: second.baseline, viewport: second.viewport },
  };
};
