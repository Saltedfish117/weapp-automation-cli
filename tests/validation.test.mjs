import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeProbe, assessNativeNodes, assessStableSamples, waitReady,
  validateNativeProbeOptions, validateNativeNodesSpec, validateReadinessSpec,
  readKeyPath, ValidationSpecError,
} from '../src/runtime/lib/validation.mjs';

const rect = (top = 0, height = 100, left = 0, width = 100) => ({ left, top, right: left + width, bottom: top + height, width, height });
const node = (key, box = rect(), style = 'height:100px;transform:translateY(0px);') => ({
  index: 0, dataset: { nodeKey: key }, rect: box, inlineStyle: style,
  computedStyle: { height: `${box.height}px`, top: '0px', position: 'absolute', transform: 'matrix(1, 0, 0, 1, 0, 0)' }, properties: {},
});
const snapshot = (nodes = [node('a')], extras = {}) => ({
  status: 'passed', source: 'wx.createSelectorQuery', coordinateSpace: 'viewport',
  nodes, viewportRect: rect(0, 100), containerRect: null, issues: [], ...extras,
});
const spec = (expected = [{ key: 'a', rect: rect() }], extras = {}) => ({ expected, ...extras });
const has = (result, code, status) => result.issues.some((entry) => entry.code === code && (!status || status === entry.status));
const bad = (run) => assert.throws(run, (error) => error instanceof ValidationSpecError && error.exitCode === 4);

// Exercise mp.evaluate's true serialization boundary: no accidental host closures.
function mockMp({ geometry = [{ ...rect(), dataset: { nodeKey: 'a' } }], inline, computed, confirm,
  viewport = { windowWidth: 100, windowHeight: 100 }, container = rect(), scroll = { scrollTop: 0, scrollLeft: 0 },
  hang = false, unavailable = false, page = { route: 'pages/test', $vm: { $scope: { tag: 'uni' } } },
  queryError = false, scrollUnsupported = false } = {}) {
  const calls = [];
  const fakeWx = {
    getWindowInfo: () => viewport,
    createSelectorQuery: unavailable ? undefined : () => {
      const requests = [];
      let geometryPass = 0;
      const q = {
        in(scope) { calls.push({ scope }); return q; },
        selectAll(selector) {
          return { fields(fields) {
            calls.push({ selector, fields });
            if (queryError) throw new Error('native fields unsupported');
            if (fields.rect) {
              const value = geometryPass++ ? confirm ?? geometry : geometry;
              requests.push(value);
            } else if (fields.properties) {
              requests.push(inline ?? geometry.map((row) => ({ dataset: row.dataset, style: 'height:100px;transform:translateY(0px);' })));
            } else {
              requests.push(computed ?? geometry.map((row) => ({ dataset: row.dataset, top: '0px', height: '100px', position: 'absolute', transform: 'matrix(1, 0, 0, 1, 0, 0)' })));
            }
            return q;
          } };
        },
        select(selector) {
          return { fields(fields) { calls.push({ selector, fields, single: true }); requests.push(container); return q; },
            scrollOffset: scrollUnsupported ? undefined : () => { requests.push(scroll); return q; } };
        },
        selectViewport: () => ({ scrollOffset: scrollUnsupported ? undefined : () => { requests.push(scroll); return q; } }),
        exec(callback) { if (!hang) callback(requests); },
      };
      return q;
    },
  };
  return {
    calls,
    async evaluate(fn, options) {
      const serialized = fn.toString();
      assert.ok(!serialized.includes('page.data'));
      const remote = Function('wx', 'getCurrentPages', `return (${serialized});`)(fakeWx, () => page ? [page] : []);
      return remote(options);
    },
  };
}

test('nativeProbe separates numeric geometry from computed top/height and reports native sources', async () => {
  const mp = mockMp({ geometry: [{ ...rect(300, 152), dataset: { nodeKey: 'a' } }],
    inline: [{ dataset: { nodeKey: 'a' }, style: 'height:152px;transform:translateY(2911px);', item: { id: 1 }, text: 'real text' }],
    computed: [{ dataset: { nodeKey: 'a' }, top: '0px', height: '152px', transform: 'matrix(1, 0, 0, 1, 0, 2911)', position: 'absolute' }] });
  const got = await nativeProbe(mp, { selector: '.row', containerSelector: '#scroller', properties: ['item', 'text'] });
  assert.equal(got.status, 'passed');
  assert.equal(got.coordinateSpace, 'viewport');
  assert.equal(got.source, 'wx.createSelectorQuery');
  assert.equal(got.nodes[0].rect.top, 300);
  assert.equal(got.nodes[0].computedStyle.top, '0px');
  assert.equal(got.nodes[0].rect.height, 152);
  assert.equal(got.nodes[0].inlineStyle, 'height:152px;transform:translateY(2911px);');
  assert.equal(got.nodes[0].text, 'real text');
  assert.deepEqual(got.nodes[0].properties.item, { id: 1 });
  assert.deepEqual(got.scroll, { scrollTop: 0, scrollLeft: 0 });
  assert.equal(got.scope, 'uni');
  for (const call of mp.calls.filter((entry) => entry.fields)) {
    assert.ok(!(call.fields.rect && call.fields.computedStyle), 'computed values must not shadow geometry');
    assert.ok(!(call.fields.rect && call.fields.properties), 'native property values do not share geometry fields');
  }
});

test('nativeProbe accepts explicit viewport and honors native page scope', async () => {
  const mp = mockMp({ viewport: null, container: rect(20, 200) });
  const got = await nativeProbe(mp, { selector: '.row', scope: 'page', containerSelector: '#scroll', viewportRect: { width: 100, height: 80 } });
  assert.equal(got.status, 'passed');
  assert.equal(got.scope, 'page');
  assert.deepEqual(got.clipRect, rect(20, 60));
});

test('nativeProbe fails capability explicitly when style/computed/dataset/geometry are unreadable', async (t) => {
  for (const [name, options] of [
    ['style', { inline: [{ dataset: { nodeKey: 'a' } }] }],
    ['computed', { computed: [{ dataset: { nodeKey: 'a' }, height: '100px' }] }],
    ['dataset', { geometry: [{ ...rect() }] }],
    ['geometry', { geometry: [{ ...rect(), top: '0px', height: '100px', dataset: { nodeKey: 'a' } }] }],
  ]) await t.test(name, async () => {
    const got = await nativeProbe(mockMp(options), { selector: '.row' });
    assert.equal(got.status, 'unsupported');
    assert.ok(got.issues.length);
  });
});

test('nativeProbe refuses cross-query count, key-order and geometry changes', async (t) => {
  for (const options of [
    { inline: [] },
    { inline: [{ dataset: { nodeKey: 'different' }, style: 'height:100px;' }] },
    { confirm: [{ ...rect(1), dataset: { nodeKey: 'a' } }] },
    { confirm: [{ ...rect(), top: undefined, dataset: { nodeKey: 'a' } }] },
  ]) await t.test(JSON.stringify(options), async () => {
    const got = await nativeProbe(mockMp(options), { selector: '.row' });
    assert.equal(got.status, 'unsupported');
    assert.equal(got.consistency.status, 'unsupported');
    assert.equal(got.nodes[0].inlineStyle, null);
  });
});

test('nativeProbe never substitutes page.data for an unavailable API or scope', async () => {
  const page = { route: 'x', data: { nodes: [node('a')] } };
  const noApi = await nativeProbe(mockMp({ unavailable: true, page }), { selector: '.row' });
  assert.equal(noApi.status, 'unsupported');
  assert.equal(noApi.nodes.length, 0);
  assert.ok(has(noApi, 'selector-query-unavailable'));
  const noUni = await nativeProbe(mockMp({ page }), { selector: '.row', scope: 'uni' });
  assert.ok(has(noUni, 'scope-unavailable'));
  const noPage = await nativeProbe(mockMp({ page: null }), { selector: '.row' });
  assert.ok(has(noPage, 'page-unavailable'));
});

test('nativeProbe protects both hung evaluate and native callbacks with a timeout', async () => {
  const hungEvaluate = await nativeProbe({ evaluate: () => new Promise(() => {}) }, { selector: '.row', timeoutMs: 15 });
  assert.equal(hungEvaluate.status, 'unsupported');
  assert.ok(has(hungEvaluate, 'probe-timeout'));
  const hungCallback = await nativeProbe(mockMp({ hang: true }), { selector: '.row', timeoutMs: 15 });
  assert.equal(hungCallback.status, 'unsupported');
  assert.ok(hungCallback.issues.some((entry) => ['probe-timeout', 'native-query-timeout'].includes(entry.code)));
});

test('nativeProbe query exception and malformed evaluate result are unsupported', async () => {
  const got = await nativeProbe(mockMp({ queryError: true }), { selector: '.row' });
  assert.ok(has(got, 'native-query-failed'));
  assert.equal((await nativeProbe({ evaluate: async () => ({}) }, { selector: '.row' })).status, 'unsupported');
});

function addSdkFallback(mp, { key = 'a', box = rect(), style = 'height:100px;', count = 1, hang = false, afterBox = box, route = 'pages/test' } = {}) {
  let offsets = 0, sizes = 0;
  const element = {
    offset: async () => { const b = offsets++ ? afterBox : box; return { left: `${b.left}px`, top: `${b.top}px` }; },
    size: async () => { const b = sizes++ ? afterBox : box; return { width: String(b.width), height: String(b.height) }; },
    attribute: async (name) => name === 'style' ? style : key,
  };
  mp.currentPage = async () => hang ? new Promise(() => {}) : { path: route, $$: async () => Array(count).fill(element) };
  return mp;
}

test('native style fallback uses SDK actual attributes only after native key/rect/count verification', async () => {
  const mp = addSdkFallback(mockMp({ inline: [{ dataset: { nodeKey: 'a' } }] }));
  const got = await nativeProbe(mp, { selector: '.row', properties: ['style'] });
  assert.equal(got.status, 'passed');
  assert.equal(got.nodes[0].inlineStyle, 'height:100px;');
  assert.equal(got.nodes[0].sources.inlineStyle, 'sdk.Element.attribute(style)');
  assert.equal(got.inlineStyleFallback.status, 'passed');
  assert.equal(got.nodes[0].properties.style, 'height:100px;');
  assert.deepEqual(got.capabilities.inlineStyle.sources, ['sdk.Element.attribute(style)']);
});

test('SDK inline fallback refuses changed count/key/rect and unreadable style', async () => {
  for (const options of [{ key: 'wrong' }, { count: 0 }, { box: rect(10) }, { afterBox: rect(10) }, { style: null }, { route: 'pages/changed' }]) {
    const mp = addSdkFallback(mockMp({ inline: [{ dataset: { nodeKey: 'a' } }] }), options);
    const got = await nativeProbe(mp, { selector: '.row' });
    assert.equal(got.status, 'unsupported');
    assert.equal(got.nodes[0].inlineStyle, null);
    assert.equal(got.inlineStyleFallback.status, 'unsupported');
  }
});

test('SDK inline fallback allows no-key static nodes only when count and rect agree', async () => {
  const mp = addSdkFallback(mockMp({ geometry: [{ ...rect(), dataset: {} }], inline: [{ dataset: {} }] }), { key: null });
  const got = await nativeProbe(mp, { selector: '.row' });
  assert.equal(got.status, 'passed');
  assert.equal(got.nodes[0].sources.inlineStyle, 'sdk.Element.attribute(style)');
});

test('SDK inline fallback is inside probe timeout budget', async () => {
  const mp = addSdkFallback(mockMp({ inline: [{ dataset: { nodeKey: 'a' } }] }), { hang: true });
  const got = await nativeProbe(mp, { selector: '.row', timeoutMs: 20 });
  assert.equal(got.status, 'unsupported');
  assert.equal(got.inlineStyleFallback.reason, 'inline-fallback-timeout');
});

test('nativeProbe scroll capability stays distinct and missing viewport is explicit', async () => {
  const unreadableScroll = await nativeProbe(mockMp({ scrollUnsupported: true }), { selector: '.row' });
  assert.equal(unreadableScroll.status, 'passed');
  assert.equal(unreadableScroll.capabilities.scroll.status, 'unsupported');
  assert.equal(unreadableScroll.scroll, null);
  const noViewport = await nativeProbe(mockMp({ viewport: null }), { selector: '.row' });
  assert.equal(noViewport.status, 'unsupported');
  assert.ok(has(noViewport, 'native-viewport-unreadable'));
});

test('actual zero nodes is an absence reading, never a successful nonempty assessment', async () => {
  const got = await nativeProbe(mockMp({ geometry: [] }), { selector: '.row' });
  assert.deepEqual(got.nodes, []);
  assert.equal(got.capabilities.rect.status, 'unsupported');
  const result = assessNativeNodes(got, spec());
  assert.equal(result.status, 'failed');
  assert.ok(has(result, 'node-count', 'failed'));
});

test('assessment jointly checks keys, viewport rectangles, inline/computed styles and content', () => {
  const n = node('a'); n.text = '账单'; n.properties = { item: { id: 7 } };
  const got = assessNativeNodes(snapshot([n]), spec([{ key: 'a', rect: rect(),
    style: { height: '100px', transform: 'translateY(0px)' }, computedStyle: { top: '0px', height: '100px' },
    dataset: { nodeKey: 'a' }, properties: { item: { id: 7 } }, text: '账单' }], { coverage: { axis: 'y', x: 50 } }));
  assert.equal(got.status, 'passed');
  assert.deepEqual(got.coverage.gaps, []);
});

test('old transform fails even when submitted business data is entirely correct', () => {
  const n = node('a', rect(100), 'height:100px;transform:translateY(100px);');
  n.computedStyle.transform = 'matrix(1, 0, 0, 1, 0, 100)';
  const snap = snapshot([n], { data: { rows: [{ key: 'a', rect: rect(200), style: 'height:100px;transform:translateY(200px);' }] } });
  const got = assessNativeNodes(snap, spec([{ key: 'a', rect: rect(200), style: { transform: 'translateY(200px)' }, computedStyle: { transform: 'matrix(1, 0, 0, 1, 0, 200)' } }]));
  assert.equal(got.status, 'failed');
  assert.ok(has(got, 'rect', 'failed'));
  assert.ok(has(got, 'style', 'failed'));
  assert.ok(has(got, 'computedStyle', 'failed'));
});

test('wrong actual rectangle fails even when actual inline style and page data look right', () => {
  const n = node('a', rect(30), 'height:100px;transform:translateY(0px);');
  const got = assessNativeNodes(snapshot([n], { page: { data: { row: rect() } } }), spec());
  assert.equal(got.status, 'failed');
  assert.ok(has(got, 'rect', 'failed'));
});

test('business keys: duplicate, missing, wrong sequence and missing rows all fail', () => {
  const duplicates = assessNativeNodes(snapshot([node('a'), node('a', rect(100))]), spec([{ key: 'a', rect: rect() }, { key: 'b', rect: rect(100) }]));
  assert.ok(has(duplicates, 'business-key-duplicate', 'failed'));
  assert.ok(has(duplicates, 'node-missing', 'failed'));
  const missing = node('a'); missing.dataset = {};
  assert.ok(has(assessNativeNodes(snapshot([missing]), spec()), 'business-key-missing', 'failed'));
  const order = assessNativeNodes(snapshot([node('b', rect(100)), node('a')]), spec([{ key: 'a', rect: rect() }, { key: 'b', rect: rect(100) }]));
  assert.ok(has(order, 'business-key-order', 'failed'));
  assert.equal(assessNativeNodes(snapshot([node('b', rect(100)), node('a')]), spec([{ key: 'a', rect: rect() }, { key: 'b', rect: rect(100) }], { requireOrder: false })).status, 'passed');
});

test('tolerance is numeric, keys are exact and style names normalize camelCase', () => {
  const n = node(0, rect(0.5)); n.inlineStyle = 'font-size:14px;height:100px;';
  assert.equal(assessNativeNodes(snapshot([n]), spec([{ key: 0, rect: { top: 0 }, style: { fontSize: '14px', height: '100.5px' } }], { tolerancePx: 1 })).status, 'passed');
  assert.equal(assessNativeNodes(snapshot([n]), spec([{ key: '0', rect: { top: 0 } }])).status, 'failed');
});

test('pixel tolerance never hides opacity, z-index or other unitless CSS mismatches', () => {
  for (const field of ['opacity', 'z-index', 'flex-grow', 'order']) {
    const n = node('a'); n.inlineStyle = `${field}:0;`; n.computedStyle = { [field]: '0' };
    for (const name of ['style', 'computedStyle']) {
      const result = assessNativeNodes(snapshot([n]), spec([{ key: 'a', [name]: { [field]: '1' } }], { tolerancePx: 100 }));
      assert.equal(result.status, 'failed', `${name}.${field} must be exact, even with large pixel tolerance`);
      assert.ok(has(result, name, 'failed'));
    }
    assert.equal(assessNativeNodes(snapshot([n]), spec([{ key: 'a', style: { [field]: '0' }, computedStyle: { [field]: '0' } }])).status, 'passed');
  }
  const n = node('a'); n.inlineStyle = 'height:100px;'; n.computedStyle = { height: '100px' };
  assert.equal(assessNativeNodes(snapshot([n]), spec([{ key: 'a', style: { height: '100.5px' }, computedStyle: { height: '100.5px' } }], { tolerancePx: 1 })).status, 'passed');
  assert.equal(assessNativeNodes(snapshot([n]), spec([{ key: 'a', style: { height: '100' } }], { tolerancePx: 1 })).status, 'failed', 'unitless vs px is not normalized');
});

test('unmeasured or fabricated native fields cannot pass', () => {
  assert.equal(assessNativeNodes({ data: { rows: [node('a')] } }, spec()).status, 'unsupported');
  assert.equal(assessNativeNodes(snapshot(), spec([{ key: 'a' }])).status, 'unsupported');
  const noRect = node('a'); noRect.rect = { ...rect(), top: '0px' };
  assert.equal(assessNativeNodes(snapshot([noRect]), spec()).status, 'unsupported');
  assert.equal(assessNativeNodes(snapshot(), spec([{ key: 'a', text: 'page.data text' }])).status, 'unsupported');
  const noStyle = node('a'); noStyle.inlineStyle = null;
  assert.equal(assessNativeNodes(snapshot([noStyle]), spec([{ key: 'a', style: { transform: 'none' } }])).status, 'unsupported');
  const noComputed = node('a'); noComputed.computedStyle = {};
  assert.equal(assessNativeNodes(snapshot([noComputed]), spec([{ key: 'a', computedStyle: { transform: 'none' } }])).status, 'unsupported');
});

test('coverage merges actual intervals rather than summing rectangle areas', () => {
  const nodes = [node('a', rect(0, 60)), node('b', rect(0, 60))];
  const expected = [{ key: 'a' }, { key: 'b' }];
  const got = assessNativeNodes(snapshot(nodes), spec(expected, { coverage: { axis: 'y', x: 50, maxGapPx: 0 } }));
  assert.equal(got.status, 'failed');
  assert.deepEqual(got.coverage.merged, [[0, 60]]);
  assert.deepEqual(got.coverage.gaps, [{ top: 60, bottom: 100, size: 40 }]);
  const middleGap = assessNativeNodes(snapshot([node('a', rect(0, 40)), node('b', rect(60, 40))]), spec(expected, { coverage: { axis: 'y', x: 50, maxGapPx: 10 } }));
  assert.deepEqual(middleGap.coverage.gaps, [{ top: 40, bottom: 60, size: 20 }]);
  assert.equal(middleGap.status, 'failed');
});

test('coverage ignores rows which miss the selected vertical probe line', () => {
  const got = assessNativeNodes(snapshot([node('a', rect(0, 100, 0, 40)), node('b', rect(0, 100, 60, 40))]), spec([{ key: 'a' }, { key: 'b' }], { coverage: { axis: 'y', x: 50, maxGapPx: 0 } }));
  assert.equal(got.status, 'failed');
  assert.equal(got.coverage.gaps[0].size, 100);
});

test('viewport/container clipping ignores offscreen row portions and clips requested range', () => {
  const nodes = [node('a', rect(-20, 80)), node('b', rect(60, 80))];
  const got = assessNativeNodes(snapshot(nodes, { containerRect: rect(20, 60), containerSelector: '#scroll' }), spec([{ key: 'a' }, { key: 'b' }], { coverage: { axis: 'y', top: -1000, bottom: 1000, maxGapPx: 0 } }));
  assert.equal(got.status, 'passed');
  assert.deepEqual(got.coverage.merged, [[20, 80]]);
  assert.equal(got.coverage.top, 20); assert.equal(got.coverage.bottom, 80);
  const outside = assessNativeNodes(snapshot(nodes), spec([{ key: 'a' }, { key: 'b' }], { coverage: { axis: 'y', x: 200 } }));
  assert.equal(outside.status, 'failed');
  const missing = assessNativeNodes(snapshot(nodes, { viewportRect: null }), spec([{ key: 'a' }, { key: 'b' }], { coverage: { axis: 'y' } }));
  assert.equal(missing.status, 'unsupported');
});

test('coverage can accept explicit inter-row gaps but must not accept a larger gap', () => {
  const snap = snapshot([node('a', rect(0, 40)), node('b', rect(45, 55))]);
  assert.equal(assessNativeNodes(snap, spec([{ key: 'a' }, { key: 'b' }], { coverage: { axis: 'y', maxGapPx: 5 } })).status, 'passed');
  assert.equal(assessNativeNodes(snap, spec([{ key: 'a' }, { key: 'b' }], { coverage: { axis: 'y', maxGapPx: 4 } })).status, 'failed');
});

test('pure stability compares full-window range, exact structure and business key strings', () => {
  assert.equal(assessStableSamples([{ at: 0, value: [{ key: 'a', top: 1 }] }, { at: 100, value: [{ key: 'a', top: 1.2 }] }, { at: 200, value: [{ key: 'a', top: 1.4 }] }]).status, 'passed');
  const drift = assessStableSamples([{ at: 0, value: 0 }, { at: 100, value: 0.4 }, { at: 200, value: 0.8 }]);
  assert.equal(drift.status, 'failed', 'adjacent samples differ <epsilon, whole window does not');
  assert.equal(assessStableSamples([{ at: 0, value: { key: 'a', top: 1 } }, { at: 200, value: { key: 'b', top: 1 } }], { stableSamples: 2 }).status, 'failed');
  assert.equal(assessStableSamples([{ at: 0, value: { top: 1 } }, { at: 200, value: { left: 1 } }], { stableSamples: 2 }).status, 'failed');
});

test('pure stability never treats absent, empty, nonfinite, numeric string or null readings as stable', () => {
  for (const value of [undefined, null, {}, [], '', '0', NaN, Infinity, { top: null }, { top: NaN }]) {
    assert.equal(assessStableSamples([{ at: 0, value }, { at: 100, value }, { at: 200, value }]).status, 'unsupported');
  }
  assert.equal(assessStableSamples([{ at: 0, value: 0 }, { at: 100, value: 0 }]).status, 'failed');
  assert.equal(assessStableSamples([{ at: 0, value: {} }, { at: 100, value: {} }, { at: 200, value: {} }], { requireNumeric: false }).status, 'unsupported');
});

function clockReader(values, { tick = 10 } = {}) {
  let time = 0, reads = 0;
  return { read: async () => { const item = values[Math.min(reads++, values.length - 1)]; if (item instanceof Error) throw item; return item; },
    runtime: { now: () => time, sleep: async (ms) => { time += ms; } }, get reads() { return reads; }, tick };
}
const readySpec = (conditions = [{ type: 'layout' }], extra = {}) => ({ conditions, timeoutMs: 100, intervalMs: 10,
  stableSamples: 3, stableWindowMs: 20, maxSamples: 20, epsilon: 0.5, ...extra });
const readySample = (top = 0, overrides = {}) => ({ route: 'pages/target', selectors: { '.row': 1 }, data: { list: [{ id: 1 }], loaded: true },
  layout: [{ key: 'a', rect: rect(top) }], scroll: 0, ...overrides });

test('readiness waits for delayed route/selector/data rendering then one continuous stable window', async () => {
  const c = clockReader([readySample(0, { route: 'pages/old', selectors: { '.row': 0 }, data: { loaded: false, list: [] } }),
    readySample(0, { selectors: { '.row': 0 } }), readySample(0), readySample(0), readySample(0)]);
  const result = await waitReady(c.read, readySpec([{ type: 'route', equals: '/pages/target' }, { type: 'selector', selector: '.row' },
    { type: 'data', keyPath: 'loaded', equals: true }, { type: 'data', keyPath: 'list', minLength: 1 }, { type: 'layout' }, { type: 'scroll' }]), c.runtime);
  assert.equal(result.status, 'passed');
  assert.equal(result.sampleCount, 5);
  assert.equal(result.window.spanMs, 20);
});

test('layout late change resets window; cannot pass using two early stable observations', async () => {
  const c = clockReader([readySample(0), readySample(0), readySample(100), readySample(100), readySample(100)]);
  const result = await waitReady(c.read, readySpec(), c.runtime);
  assert.equal(result.status, 'passed');
  assert.equal(result.sampleCount, 5);
  assert.equal(result.lastSample.layout[0].rect.top, 100);
});

test('every condition participates in continuous window, including changing selector/data values', async () => {
  const conditions = [{ type: 'selector', selector: '.row' }, { type: 'data', keyPath: 'list', minLength: 1 }, { type: 'layout' }];
  const c = clockReader([readySample(), readySample(), readySample(0, { selectors: { '.row': 2 }, data: { list: [{ id: 2 }] } }),
    readySample(0, { selectors: { '.row': 2 }, data: { list: [{ id: 2 }] } }), readySample(0, { selectors: { '.row': 2 }, data: { list: [{ id: 2 }] } })]);
  const result = await waitReady(c.read, readySpec(conditions), c.runtime);
  assert.equal(result.status, 'passed');
  assert.equal(result.sampleCount, 5);
});

test('route failure or missing scroll resets all simultaneous conditions', async () => {
  const c = clockReader([readySample(), readySample(), readySample(0, { scroll: null }), readySample(), readySample(), readySample()]);
  const result = await waitReady(c.read, readySpec([{ type: 'layout' }, { type: 'scroll' }]), c.runtime);
  assert.equal(result.status, 'passed');
  assert.equal(result.sampleCount, 6);
});

test('unreadable scroll cannot become stable and timeout includes last sample/unmet conditions', async () => {
  const c = clockReader([readySample(0, { scroll: null })]);
  const result = await waitReady(c.read, readySpec([{ type: 'layout' }, { type: 'scroll' }], { timeoutMs: 50 }), c.runtime);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.lastSample.scroll, null);
  assert.equal(result.unmetConditions[0].type, 'scroll');
  assert.equal(result.unmetConditions[0].reason, 'scroll-unreadable');
});

test('wrong route/data values time out as failed, not unsupported', async () => {
  const c = clockReader([readySample(0, { route: 'pages/wrong', data: { loaded: false } })]);
  const result = await waitReady(c.read, readySpec([{ type: 'route', equals: 'pages/target' }, { type: 'data', keyPath: 'loaded', equals: true }], { maxSamples: 3 }), c.runtime);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'max-samples');
  assert.equal(result.sampleCount, 3);
  assert.equal(result.unmetConditions.length, 2);
});

test('missing layout and scroll remain unsupported; empty JSON is not stability', async () => {
  for (const value of [null, [], {}, '0', { top: null }]) {
    const c = clockReader([readySample(0, { layout: value, scroll: value })]);
    const result = await waitReady(c.read, readySpec([{ type: 'layout' }, { type: 'scroll' }], { maxSamples: 3 }), c.runtime);
    assert.equal(result.status, 'unsupported');
    assert.equal(result.window.sampleCount, 0);
  }
});

test('layout key changes and bounded numeric drift keep readiness from passing', async () => {
  const c = clockReader([readySample(0), readySample(0.4), readySample(0.8), readySample(1.2), readySample(1.6)]);
  const result = await waitReady(c.read, readySpec([{ type: 'layout' }], { maxSamples: 5 }), c.runtime);
  assert.equal(result.status, 'failed');
  assert.ok(result.window.sampleCount < 3);
});

test('data deep equality permits empty object/null values when explicitly expected (not missing)', async () => {
  const c = clockReader([{ data: { x: null, y: {} } }]);
  const result = await waitReady(c.read, readySpec([{ type: 'data', keyPath: 'x', equals: null }, { type: 'data', keyPath: 'y', equals: {} }]), c.runtime);
  assert.equal(result.status, 'passed');
});

test('hung reader is bounded; reader errors retain last successful sample and do not pass', async () => {
  const hung = await waitReady(() => new Promise(() => {}), readySpec([{ type: 'scroll' }], { timeoutMs: 20, stableWindowMs: 10 }));
  assert.equal(hung.status, 'unsupported');
  assert.equal(hung.lastReadError.code, 'ready-read-timeout');
  assert.equal(hung.lastSample, null);
  const c = clockReader([readySample(), new Error('native disappeared')]);
  const result = await waitReady(c.read, readySpec([{ type: 'layout' }], { maxSamples: 3 }), c.runtime);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.lastReadError.message, 'native disappeared');
  assert.equal(result.lastSample.route, 'pages/target');
});

test('safe data keyPath handles dot and array indices, forbids code/prototype paths', () => {
  assert.deepEqual(readKeyPath({ rows: [{ id: 4 }] }, 'rows[0].id'), { found: true, value: 4 });
  assert.deepEqual(readKeyPath({ rows: [{ id: 4 }] }, 'rows.0.id'), { found: true, value: 4 });
  assert.deepEqual(readKeyPath({ rows: [] }, 'rows[0].id'), { found: false, value: null });
  assert.deepEqual(readKeyPath(Object.create({ inherited: 7 }), 'inherited'), { found: false, value: null });
  for (const path of ['__proto__.x', 'a.constructor.name', 'a.prototype', 'a[fn()]', 'a..x', 'a;process.exit()']) bad(() => readKeyPath({}, path));
});

test('unavailable probe or dataset stays unsupported rather than fabricating business failures', async () => {
  const unavailable = await nativeProbe({ evaluate: async () => { throw new Error('connection unavailable'); } }, { selector: '.row' });
  assert.equal(assessNativeNodes(unavailable, spec()).status, 'unsupported');
  const n = node('a'); n.dataset = null;
  const result = assessNativeNodes(snapshot([n]), spec());
  assert.equal(result.status, 'unsupported');
  assert.ok(result.issues.every((item) => item.status === 'unsupported'));
});

test('exact inline CSS string detects obsolete extra transform, property subset remains supported', () => {
  const snap = snapshot([node('a')]);
  assert.equal(assessNativeNodes(snap, spec([{ key: 'a', style: 'height:100px;' }])).status, 'failed');
  assert.equal(assessNativeNodes(snap, spec([{ key: 'a', style: { height: '100px' } }])).status, 'passed');
  assert.equal(assessNativeNodes(snap, spec([{ key: 'a', style: 'transform: translateY(0px); height: 100px;' }])).status, 'passed');
});

test('layout may include empty dataset metadata while empty geometry itself stays unsupported', async () => {
  const c = clockReader([{ layout: [{ rect: rect(), dataset: {} }] }]);
  const result = await waitReady(c.read, readySpec(), c.runtime);
  assert.equal(result.status, 'passed');
});

test('route stops matching resets stable window even with unchanged layout', async () => {
  const c = clockReader([readySample(), readySample(), readySample(0, { route: 'pages/old' }), readySample(), readySample(), readySample()]);
  const result = await waitReady(c.read, readySpec([{ type: 'route', equals: 'pages/target' }, { type: 'layout' }]), c.runtime);
  assert.equal(result.status, 'passed');
  assert.equal(result.sampleCount, 6);
});

test('schema rejects invalid probe/assessment/readiness inputs before any I/O', async () => {
  for (const options of [{}, { selector: '' }, { selector: '.row', timeoutMs: 0 }, { selector: '.row', scope: 'vm' },
    { selector: '.row', computedStyle: 'top' }, { selector: '.row', properties: ['style', 'style'] },
    { selector: '.row', viewportRect: { width: -1, height: 20 } }, { selector: '.row', magic: true },
    { selector: '.row', timeoutMs: null }, { selector: '.row', properties: null }]) bad(() => validateNativeProbeOptions(options));
  for (const options of [{ expected: [] }, { expected: [{}] }, { expected: [{ key: 'a', rect: {} }] },
    { expected: [{ key: 'a', rect: { top: '0px' } }] }, { expected: [{ key: 'a', style: 'broken' }] },
    { expected: [{ key: 'a', computedStyle: {} }] }, { expected: [{ key: 'a' }, { key: 'a' }] },
    { expected: [{ key: 'a' }], coverage: { axis: 'x' } }, { expected: [{ key: 'a' }], coverage: { axis: 'y', top: 5, bottom: 4 } },
    { expected: [{ key: 'a' }], requireUniqueKeys: 'true' }]) bad(() => validateNativeNodesSpec(options));
  const wrongSpecs = [{}, { conditions: [] }, { conditions: [{ type: 'unknown' }] }, { conditions: [{ type: 'route' }] },
    { conditions: [{ type: 'data', keyPath: 'loaded' }] }, { conditions: [{ type: 'selector', selector: '.row', maxCount: 0 }] },
    { conditions: [{ type: 'layout', epsilon: -1 }] }, { conditions: [{ type: 'data', keyPath: 'x()', equals: true }] },
    readySpec(undefined, { maxSamples: 2 }), readySpec(undefined, { stableSamples: 1 }), readySpec(undefined, { stableWindowMs: 101 }), readySpec(undefined, { epsilon: null }),
    { conditions: [{ type: 'layout' }], layoutSelector: '.row' }];
  for (const wrong of wrongSpecs) bad(() => validateReadinessSpec(wrong));
  let calls = 0;
  await assert.rejects(nativeProbe({ evaluate: () => { calls++; } }, { selector: '.row', timeoutMs: '1' }), ValidationSpecError);
  await assert.rejects(waitReady(() => { calls++; }, {}), ValidationSpecError);
  assert.equal(calls, 0);
});
