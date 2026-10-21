import { CliError, EXIT, withTimeout } from './output.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function readNativeScroll(mp, { selector = null, timeoutMs = 2000 } = {}) {
  return withTimeout(mp.evaluate(function (options) {
    const selector = options.selector;
    const timeoutMs = options.timeoutMs;
    return new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish({ status: 'unsupported', reason: 'native-scroll-query-timeout', top: null }), timeoutMs);
    try {
      const current = getCurrentPages().slice(-1)[0];
      const scope = current?.$vm?.$scope;
      let query = wx.createSelectorQuery();
      if (scope) query = query.in(scope);
      if (selector) query.select(selector).scrollOffset();
      else query.selectViewport().scrollOffset();
      query.exec(values => {
        const value = values?.[0];
        if (!value || typeof value.scrollTop !== 'number' || !Number.isFinite(value.scrollTop)) {
          finish({ status: 'unsupported', reason: 'native-scroll-unavailable', top: null });
        } else finish({ status: 'passed', top: value.scrollTop, left: value.scrollLeft ?? null,
          scrollHeight: value.scrollHeight ?? null, scrollWidth: value.scrollWidth ?? null,
          source: 'wx.createSelectorQuery.scrollOffset', selector, route: current?.route ?? current?.__route__ ?? null });
      });
    } catch (error) { finish({ status: 'unsupported', reason: error.message, top: null }); }
    });
  }, { selector, timeoutMs }), timeoutMs + 300, 'native scroll query');
}

/** Pure summary: synthetic input must never be certified as a physical gesture. */
export function assessScrollTrace(samples, { releaseAtMs = null, minDisplacementPx = 5, epsilon = 0.5,
  interaction = 'observation', requireInertia = false } = {}) {
  if (!Array.isArray(samples) || ![minDisplacementPx, epsilon].every(v => Number.isFinite(v) && v >= 0) ||
      (releaseAtMs !== null && (!Number.isFinite(releaseAtMs) || releaseAtMs < 0)) ||
      !['observation', 'sdk-touch-events', 'external-gesture-observed', 'programmatic-scroll'].includes(interaction)) {
    throw new CliError('invalid scroll trace assessment options', { exitCode: EXIT.CONFIG, code: 'bad-spec' });
  }
  const valid = samples.filter(s => Number.isFinite(s.top));
  const before = valid[0]?.top ?? null;
  const after = valid.at(-1)?.top ?? null;
  const displacement = before === null || after === null ? null : after - before;
  const range = valid.length ? Math.max(...valid.map(s => s.top)) - Math.min(...valid.map(s => s.top)) : null;
  const released = releaseAtMs === null ? [] : valid.filter(s => s.elapsedMs >= releaseAtMs);
  const inertiaRange = released.length >= 2 ? Math.max(...released.map(s => s.top)) - Math.min(...released.map(s => s.top)) : null;
  const moved = valid.length >= 2 && range >= minDisplacementPx;
  const inertiaObserved = inertiaRange !== null && inertiaRange > epsilon;
  const unavailable = samples.length !== valid.length || valid.length < 2;
  const uncovered = [];
  if (unavailable) uncovered.push('native-scroll-measurement');
  if (!moved) uncovered.push('gesture-displacement');
  if (!inertiaObserved) uncovered.push('post-release-inertia');
  // SDK event dispatch is not trusted OS input even when an app handler changes scrollTop.
  if (interaction !== 'external-gesture-observed') uncovered.push('physical-gesture');
  if (interaction === 'external-gesture-observed') uncovered.push('physical-input-source-not-verified-by-sdk');
  return { status: unavailable || !moved || (requireInertia && !inertiaObserved) ? 'unsupported' : 'passed',
    interaction, before, after, displacement, range, moved, inertiaRange, inertiaObserved,
    physicalGestureVerified: false, uncovered, sampleCount: samples.length, samples };
}

export async function observeScroll(mp, options = {}) {
  const { selector = null, durationMs = 1200, intervalMs = 60, timeoutMs = 2000,
    releaseAtMs = null, interaction = 'observation', signal, ...assessment } = options;
  const allowed = ['selector','durationMs','intervalMs','timeoutMs','releaseAtMs','interaction','signal','minDisplacementPx','epsilon','requireInertia'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new CliError(`unknown scroll observation option ${key}`, { exitCode: EXIT.CONFIG, code: 'bad-spec' });
  assessScrollTrace([], {releaseAtMs, interaction, ...assessment});
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
      !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 60000 ||
      !Number.isFinite(intervalMs) || intervalMs < 10 || intervalMs > 5000) {
    throw new CliError('invalid scroll observation duration/interval', { exitCode: EXIT.CONFIG, code: 'bad-spec' });
  }
  const started = Date.now(), samples = [];
  do {
    signal?.throwIfAborted();
    const sample = await readNativeScroll(mp, { selector, timeoutMs });
    samples.push({ elapsedMs: Date.now() - started, ...sample });
    if (Date.now() - started >= durationMs) break;
    await sleep(intervalMs);
  } while (true);
  return assessScrollTrace(samples, { releaseAtMs, interaction, ...assessment });
}

/** Attempt SDK touch events, measure real native offset, never fall back to scrollTo. */
export async function attemptSwipe(mp, element, options = {}) {
  const { selector, from = { x: 150, y: 600 }, to = { x: 150, y: 250 },
    durationMs = 250, steps = 6, observeMs = 1200, intervalMs = 60,
    minDisplacementPx = 5, requireInertia = false, signal } = options;
  if (!selector || ![from.x, from.y, to.x, to.y, durationMs, steps, observeMs, intervalMs, minDisplacementPx].every(Number.isFinite) ||
      !Number.isInteger(steps) || steps < 1 || steps > 100 || durationMs < 1 || durationMs > 10000 ||
      observeMs < 100 || observeMs > 60000 || intervalMs < 10 || minDisplacementPx < 0) {
    throw new CliError('swipe requires selector, finite points, valid duration and steps', { exitCode: EXIT.CONFIG, code: 'bad-spec' });
  }
  const start = Date.now(), samples = [];
  const sample = async () => samples.push({ elapsedMs: Date.now() - start, ...await readNativeScroll(mp, { selector }) });
  const touch = (x, y) => ({ identifier: 1, pageX: x, pageY: y, clientX: x, clientY: y });
  const send = async (method, point, ended = false) => {
    signal?.throwIfAborted();
    if (typeof element[method] !== 'function') throw new CliError(`SDK ${method} is unavailable`, { exitCode: EXIT.CONFIG, code: 'unsupported' });
    await withTimeout(element[method]({ touches: ended ? [] : [point], changedTouches: [point] }), 2000, `SDK ${method}`);
  };
  await sample();
  await send('touchstart', touch(from.x, from.y));
  try {
    for (let i = 1; i <= steps; i++) {
      await sleep(durationMs / steps);
      await send('touchmove', touch(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps));
      await sample();
    }
  } finally {
    // Touch cancellation uses touchend to avoid leaving an input stream open.
    await withTimeout(element.touchend({ touches: [], changedTouches: [touch(to.x, to.y)] }), 2000, 'SDK touchend');
  }
  const releaseAtMs = Date.now() - start;
  await sample();
  const deadline = Date.now() + observeMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    await sleep(intervalMs);
    await sample();
  }
  return assessScrollTrace(samples, { releaseAtMs, minDisplacementPx, requireInertia, interaction: 'sdk-touch-events' });
}
