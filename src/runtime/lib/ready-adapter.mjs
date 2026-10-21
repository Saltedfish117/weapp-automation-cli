import { CliError, EXIT, withTimeout } from './output.mjs';
import { nativeProbe, waitReady, validateReadinessSpec, readKeyPath } from './validation.mjs';
import { readNativeScroll } from './scroll-check.mjs';

export function validateReadyAdapterSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new CliError('ready spec must be an object', { exitCode: EXIT.CONFIG, code: 'bad-spec' });
  const conditions = spec.conditions;
  if (!Array.isArray(conditions) || !conditions.length) throw new CliError('ready requires non-empty conditions', { exitCode: EXIT.CONFIG, code: 'bad-spec' });
  if (conditions.some(c => c?.type === 'layout') && !spec.layoutSelector) throw new CliError('layout readiness requires layoutSelector', { exitCode: EXIT.CONFIG, code: 'bad-spec' });
  for (const key of ['layoutSelector', 'scrollSelector', 'scope']) {
    if (spec[key] !== undefined && typeof spec[key] !== 'string') throw new CliError(`${key} must be a string`, { exitCode: EXIT.CONFIG, code: 'bad-spec' });
  }
  const { layoutSelector, scrollSelector, scope, ...waitSpec } = spec;
  if (scope !== undefined && !['auto', 'uni', 'page'].includes(scope)) throw new CliError('invalid ready scope', { exitCode: EXIT.CONFIG, code: 'bad-spec' });
  validateReadinessSpec(waitSpec);
  return spec;
}

export async function readyFor(mp, spec, { signal } = {}) {
  validateReadyAdapterSpec(spec);
  const { layoutSelector, scrollSelector, scope = 'auto', ...waitSpec } = spec;
  const read = async () => {
    signal?.throwIfAborted();
    const page = await withTimeout(mp.currentPage(), 2000, 'ready current page');
    if (!page) return { route: null, selectors: {}, data: null, layout: null, scroll: null };
    const sample = { route: page.path, selectors: {}, data: null, layout: null, scroll: null };
    for (const c of spec.conditions.filter(c => c.type === 'selector')) {
      sample.selectors[c.selector] = (await withTimeout(page.$$(c.selector), 2000, `ready selector ${c.selector}`)).length;
    }
    if (spec.conditions.some(c => c.type === 'data')) {
      const raw = await withTimeout(page.data(), 2000, 'ready data');
      sample.data = {};
      // Only selected paths matter; unrelated functions/undefined in page.data
      // must not poison an otherwise valid readiness sample.
      for (const c of spec.conditions.filter(c => c.type === 'data')) {
        const reading = readKeyPath(raw, c.keyPath);
        if (!reading.found || reading.value === undefined) continue;
        const keys = c.keyPath.replace(/\[(\d+)\]/g, '.$1').split('.');
        let cursor = sample.data;
        for (let i = 0; i < keys.length - 1; i++) cursor = cursor[keys[i]] ??= {};
        cursor[keys.at(-1)] = reading.value; // Keep invalid/undefined/nonfinite observations invalid; never normalize them into matching null/{}.
      }
    }
    if (spec.conditions.some(c => c.type === 'layout')) {
      const snapshot = await nativeProbe(mp, { selector: layoutSelector, scope, computedStyle: [], properties: [], timeoutMs: 2000 });
      if (snapshot.route === page.path && snapshot.capabilities?.rect?.status === 'passed' && snapshot.consistency?.status === 'passed') {
        sample.layout = snapshot.nodes.map(n => ({ rect: n.rect, key: String(n.dataset?.nodeKey ?? n.index) }));
      } else if (snapshot.route !== page.path) sample.route = null;
    }
    if (spec.conditions.some(c => c.type === 'scroll')) {
      const scroll = await readNativeScroll(mp, { selector: scrollSelector });
      sample.scroll = scroll.status === 'passed' && scroll.route === page.path ? scroll.top : null;
    }
    const endPage = await withTimeout(mp.currentPage(), 2000, 'ready route confirmation');
    if (endPage?.path !== page.path) { sample.route = null; sample.layout = null; sample.scroll = null; }
    return sample;
  };
  return waitReady(read, waitSpec);
}
