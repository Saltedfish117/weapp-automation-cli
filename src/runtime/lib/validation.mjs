/**
 * Native, read-only validation. No SDK/CLI dependency and no page.data geometry.
 *
 * nativeProbe(mp, {selector, containerSelector?, viewportRect?, scope?:'auto'|'page'|'uni',
 *   keyAttribute?:'nodeKey', computedStyle?:string[], properties?:string[], timeoutMs?:3000})
 * returns a JSON snapshot with source='wx.createSelectorQuery', coordinateSpace='viewport',
 * nodes:[{index,dataset,rect,inlineStyle,computedStyle,properties,text?,available}],
 * viewportRect/containerRect/clipRect/scroll, capabilities, consistency and issues.
 * Geometry and computed styles MUST be separate queries: computed top/height overwrite
 * geometric top/height in WeChat fields(). A second geometry query guards the index join.
 * Scope auto uses the current uni-app $vm.$scope when present, otherwise the native page.
 * properties adds native properties (e.g. item/text); style is always requested. Text is
 * NOT innerText: it can only be asserted when the native query actually returned text.
 * When native properties.style is absent, a bounded read-only SDK attribute fallback
 * is accepted ONLY after same-count/key (if present)/native rect identity verification,
 * with SDK offset/size rechecked before/after style capture. Per-node sources disclose it.
 * Probe 'passed' means requested readings were obtained, NOT that the layout is correct.
 *
 * assessNativeNodes(snapshot, {expected:[{key,rect?,style?,computedStyle?,dataset?,
 *   properties?,text?}], keyAttribute?:'nodeKey', tolerancePx?:1,
 *   requireUniqueKeys?:true, requireOrder?:true,
 *   coverage?:{axis:'y',x?,top?,bottom?,maxGapPx?}})
 * compares the entire selected set. Rect expectations are partial VIEWPORT rectangles;
 * convert list-local positions explicitly at the caller, never subtract scroll twice.
 * style is an inline CSS declaration string or a nonempty property/value subset.
 * computedStyle is a nonempty property/value subset (use actual computed CSS syntax).
 * Coverage merges actual rect intervals on ONE vertical x line, clipped to the viewport
 * and optional container. Its allowed gap defaults to tolerancePx; no area sums are used.
 * Empty expectations are invalid; key-only assertions without coverage are unsupported.
 *
 * waitReady(read, spec, runtime?) reads {route,selectors:{[selector]:count},data,layout,scroll}.
 * spec={conditions:[{type:'route',equals:string},
 *   {type:'selector',selector:string,minCount?:1,maxCount?},
 *   {type:'data',keyPath:string,equals?:JSON,minLength?:number},
 *   {type:'layout'|'scroll',path?:'layout'|'scroll',epsilon?}],
 *   timeoutMs?:5000,intervalMs?:100,maxSamples?:100,stableSamples?:3,
 *   stableWindowMs?:200,epsilon?:0.5}.
 * Every condition must hold in the SAME continuous stable window. Layout/scroll require
 * finite numeric readings; layout may include exact structural/string business keys.
 * Scroll is a number or an object/array containing only finite numeric leaves.
 * runtime={now?:()=>number,sleep?:(ms)=>Promise<void>} is for deterministic mock tests.
 * Timeouts return lastSample, unmetConditions, lastReadError; they do not cancel an SDK
 * request already in flight. Readers should themselves be bounded/read-only.
 *
 * All result statuses are 'passed' | 'failed' | 'unsupported'. Missing/unreadable native
 * evidence is never a pass. Invalid inputs throw ValidationSpecError (exitCode=4).
 */

export class ValidationSpecError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'ValidationSpecError';
    this.code = 'bad-validation-spec';
    this.exitCode = 4;
  }
}

const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const defaulted = (value, fallback) => value === undefined ? fallback : value;
const RECT_KEYS = ['left', 'top', 'right', 'bottom', 'width', 'height'];
const DEFAULT_STYLES = ['position', 'top', 'height', 'transform'];
const issue = (status, code, details = {}) => ({ status, code, ...details });
const statusOf = (checks) => checks.some((c) => c.status === 'failed') ? 'failed'
  : checks.some((c) => c.status === 'unsupported') ? 'unsupported' : 'passed';

function invalid(message) { throw new ValidationSpecError(message); }
function object(value, label) { if (!record(value)) invalid(`${label} must be an object`); }
function fields(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${label}.${key} is not supported`);
    // Optional config values are omitted, not null. Literal expected JSON equals
    // and observed stability values may intentionally be null.
    if (value[key] === null && !['equals', 'value'].includes(key)) invalid(`${label}.${key} must not be null`);
  }
}
function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be a nonempty string`);
  return value;
}
function number(value, label, min = 0, integer = false) {
  if (!finite(value) || value < min || (integer && !Number.isInteger(value))) {
    invalid(`${label} must be ${integer ? 'an integer' : 'a finite number'} >= ${min}`);
  }
  return value;
}
function bool(value, label) { if (typeof value !== 'boolean') invalid(`${label} must be boolean`); return value; }
function json(value, label, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) invalid(`${label} must be finite, acyclic JSON`);
  seen.add(value);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid(`${label} must be plain JSON`);
  }
  for (const entry of Object.values(value)) json(entry, label, seen);
  seen.delete(value);
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function same(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] && same(a[key], b[key]));
}

function rectSpec(value, label, partial = false, originDefault = false) {
  fields(value, RECT_KEYS, label);
  if (!Object.keys(value).length) invalid(`${label} must contain rectangle fields`);
  for (const [key, val] of Object.entries(value)) number(val, `${label}.${key}`, ['width', 'height'].includes(key) ? 0 : -Infinity);
  if (partial) {
    for (const [start, end, size] of [['left', 'right', 'width'], ['top', 'bottom', 'height']]) {
      if (finite(value[start]) && finite(value[end]) && (value[end] < value[start]
          || (finite(value[size]) && Math.abs(value[end] - value[start] - value[size]) > 0.01))) {
        invalid(`${label} has inconsistent ${start}/${end}/${size}`);
      }
    }
    return { ...value };
  }
  const out = { ...value };
  if (originDefault) { out.left ??= 0; out.top ??= 0; }
  if (!finite(out.width) && finite(out.left) && finite(out.right)) out.width = out.right - out.left;
  if (!finite(out.height) && finite(out.top) && finite(out.bottom)) out.height = out.bottom - out.top;
  if (!finite(out.left) && finite(out.right) && finite(out.width)) out.left = out.right - out.width;
  if (!finite(out.top) && finite(out.bottom) && finite(out.height)) out.top = out.bottom - out.height;
  if (!finite(out.right) && finite(out.left) && finite(out.width)) out.right = out.left + out.width;
  if (!finite(out.bottom) && finite(out.top) && finite(out.height)) out.bottom = out.top + out.height;
  if (!RECT_KEYS.every((key) => finite(out[key])) || out.width < 0 || out.height < 0
      || Math.abs(out.right - out.left - out.width) > 0.01 || Math.abs(out.bottom - out.top - out.height) > 0.01) {
    invalid(`${label} must be a complete, consistent numeric rectangle`);
  }
  return out;
}
function measuredRect(value) {
  if (!record(value) || !RECT_KEYS.every((key) => finite(value[key]))) return null;
  if (value.width < 0 || value.height < 0 || Math.abs(value.right - value.left - value.width) > 0.1
      || Math.abs(value.bottom - value.top - value.height) > 0.1) return null;
  return Object.fromEntries(RECT_KEYS.map((key) => [key, value[key]]));
}
function intersect(a, b) {
  if (!a || !b) return null;
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
function keyValid(value) { return (typeof value === 'string' && value.length > 0) || finite(value); }
function keyToken(value) { return `${typeof value}:${String(value)}`; }
function strings(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array of property names`);
  value.forEach((v) => nonempty(v, label));
  if (new Set(value).size !== value.length) invalid(`${label} contains duplicate property names`);
  return [...value];
}
export function validateNativeProbeOptions(options = {}) { const spec = probeOptions(options); return spec; }
export function validateNativeNodesSpec(options = {}) { expectationSpec(options); return options; }

function probeOptions(options) {
  fields(options, ['selector', 'containerSelector', 'viewportRect', 'computedStyle', 'properties', 'keyAttribute', 'scope', 'timeoutMs'], 'probe');
  const out = { selector: nonempty(options.selector, 'probe.selector'),
    keyAttribute: nonempty(options.keyAttribute ?? 'nodeKey', 'probe.keyAttribute'),
    scope: options.scope ?? 'auto', timeoutMs: number(defaulted(options.timeoutMs, 3000), 'probe.timeoutMs', 1),
    computedStyle: strings(options.computedStyle ?? DEFAULT_STYLES, 'probe.computedStyle'),
    properties: strings(options.properties ?? [], 'probe.properties') };
  if (!['auto', 'page', 'uni'].includes(out.scope)) invalid('probe.scope must be auto, page or uni');
  if (own(options, 'containerSelector')) out.containerSelector = nonempty(options.containerSelector, 'probe.containerSelector');
  if (own(options, 'viewportRect')) {
    out.viewportRect = rectSpec(options.viewportRect, 'probe.viewportRect', false, true);
    if (out.viewportRect.width <= 0 || out.viewportRect.height <= 0) invalid('probe.viewportRect must have positive width and height');
  }
  return out;
}

// This function is serialized by mp.evaluate. Keep ALL its dependencies inside it.
async function probeInApp(options) {
  const unverified = (code, message) => ({ error: { code, message } });
  if (typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function') {
    return unverified('selector-query-unavailable', 'wx.createSelectorQuery is unavailable');
  }
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  const page = pages[pages.length - 1];
  if (!page) return unverified('page-unavailable', 'There is no current native page');
  const uni = page.$vm && page.$vm.$scope;
  if (options.scope === 'uni' && !uni) return unverified('scope-unavailable', 'Current page has no uni-app $scope');
  let viewport = options.viewportRect || null;
  if (!viewport) {
    let info;
    try { if (typeof wx.getWindowInfo === 'function') info = wx.getWindowInfo(); } catch (_) { /* use legacy API */ }
    try { if (!info && typeof wx.getSystemInfoSync === 'function') info = wx.getSystemInfoSync(); } catch (_) { /* explicitly absent */ }
    if (info && typeof info.windowWidth === 'number' && typeof info.windowHeight === 'number') {
      viewport = { left: 0, top: 0, right: info.windowWidth, bottom: info.windowHeight, width: info.windowWidth, height: info.windowHeight };
    }
  }
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(unverified('native-query-timeout', 'Native selector query callback timed out')), options.timeoutMs);
    function finish(value) { if (!done) { done = true; clearTimeout(timer); resolve(value); } }
    try {
      let q = wx.createSelectorQuery();
      const target = options.scope === 'page' ? page : uni || page;
      if (typeof q.in !== 'function') { finish(unverified('scope-unavailable', 'SelectorQuery.in is unavailable')); return; }
      q = q.in(target);
      const geom = { rect: true, size: true, dataset: true };
      const slots = {};
      let slot = 0;
      slots.geometry = slot++;
      q.selectAll(options.selector).fields(geom);
      slots.inline = slot++;
      q.selectAll(options.selector).fields({ dataset: true, properties: [...new Set(['style', ...options.properties])] });
      if (options.computedStyle.length) {
        slots.computed = slot++;
        q.selectAll(options.selector).fields({ dataset: true, computedStyle: options.computedStyle });
      }
      slots.confirm = slot++;
      q.selectAll(options.selector).fields(geom);
      if (options.containerSelector) {
        slots.container = slot++;
        q.select(options.containerSelector).fields(geom);
      }
      let scrollError = null;
      try {
        const scrollNode = options.containerSelector ? q.select(options.containerSelector) : q.selectViewport();
        if (!scrollNode || typeof scrollNode.scrollOffset !== 'function') throw new Error('scrollOffset is unavailable');
        scrollNode.scrollOffset();
        slots.scroll = slot++;
      } catch (error) { scrollError = String(error && error.message || error); }
      q.exec((result) => finish({ result, slots, viewport, route: page.route || page.path || null,
        scope: target === uni ? 'uni' : 'page', scrollError }));
    } catch (error) { finish(unverified('native-query-failed', String(error && error.message || error))); }
  });
}

async function bounded(promise, ms, code) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new Error(`${code} after ${ms}ms`); error.code = code; reject(error); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

function sdkNumber(value) {
  if (finite(value)) return value;
  if (typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(value.trim())) return Number.parseFloat(value);
  return null;
}

async function fallbackInlineStyles(mp, nodes, spec, route) {
  if (typeof mp.currentPage !== 'function') return { status: 'unsupported', reason: 'sdk-current-page-unavailable' };
  const page = await mp.currentPage();
  if (!page || typeof page.$$ !== 'function') return { status: 'unsupported', reason: 'sdk-elements-unavailable' };
  if (route && (!page.path || page.path.replace(/^\//, '') !== route.replace(/^\//, ''))) return { status: 'unsupported', reason: 'sdk-native-route-changed' };
  const elements = await page.$$(spec.selector);
  if (!Array.isArray(elements) || elements.length !== nodes.length) return { status: 'unsupported', reason: 'sdk-node-count-changed' };
  const styles = [];
  const keyName = `data-${spec.keyAttribute.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index], native = nodes[index];
    if (!element || typeof element.attribute !== 'function' || typeof element.offset !== 'function' || typeof element.size !== 'function') {
      return { status: 'unsupported', reason: 'sdk-node-fields-unavailable', index };
    }
    const hasKey = keyValid(native.dataset?.[spec.keyAttribute]);
    const [beforeOffset, beforeSize, style, key] = await Promise.all([
      element.offset(), element.size(), element.attribute('style'), hasKey ? element.attribute(keyName) : null,
    ]);
    const [afterOffset, afterSize] = await Promise.all([element.offset(), element.size()]);
    const matches = (offset, size) => {
      const measured = { left: sdkNumber(offset?.left), top: sdkNumber(offset?.top), width: sdkNumber(size?.width), height: sdkNumber(size?.height) };
      return Object.entries(measured).every(([name, value]) => finite(value) && Math.abs(value - native.rect[name]) <= 0.1);
    };
    if (!matches(beforeOffset, beforeSize) || !matches(afterOffset, afterSize)
        || (hasKey && (key == null || String(key) !== String(native.dataset[spec.keyAttribute])))) {
      return { status: 'unsupported', reason: 'sdk-native-node-identity-or-rect-changed', index };
    }
    if (typeof style !== 'string') return { status: 'unsupported', reason: 'sdk-inline-style-unreadable', index };
    styles.push(style);
  }
  return { status: 'passed', styles, source: 'sdk.Element.attribute(style)',
    identity: 'same-count-index-native-key-when-present-and-native-rect-before-after' };
}

/** Read actual native nodes; page.data/vm are NEVER a measurement source. */
export async function nativeProbe(mp, options = {}) {
  const spec = probeOptions(options), started = Date.now();
  if (!mp || typeof mp.evaluate !== 'function') invalid('nativeProbe requires mp.evaluate');
  const base = { source: 'wx.createSelectorQuery', coordinateSpace: 'viewport', selector: spec.selector,
    containerSelector: spec.containerSelector ?? null, keyAttribute: spec.keyAttribute, nodes: [], viewportRect: spec.viewportRect ?? null,
    containerRect: null, clipRect: null, scroll: null, capabilities: {}, issues: [] };
  let raw;
  try { raw = await bounded(Promise.resolve().then(() => mp.evaluate(probeInApp, spec)), spec.timeoutMs, 'probe-timeout'); }
  catch (error) { raw = { error: { code: error.code || 'evaluate-failed', message: String(error.message || error) } }; }
  if (!raw || raw.error || !Array.isArray(raw.result) || !record(raw.slots)) {
    return { ...base, status: 'unsupported', issues: [issue('unsupported', raw?.error?.code || 'native-result-unreadable', { message: raw?.error?.message || 'Native query did not return result slots' })] };
  }
  const { result, slots } = raw;
  const geometry = result[slots.geometry], inline = result[slots.inline];
  const computed = own(slots, 'computed') ? result[slots.computed] : null;
  const confirm = result[slots.confirm];
  const checks = [];
  let coherent = Array.isArray(geometry) && Array.isArray(inline) && Array.isArray(confirm)
    && (!spec.computedStyle.length || Array.isArray(computed));
  if (!coherent) checks.push(issue('unsupported', 'native-node-arrays-unreadable'));
  const rows = Array.isArray(geometry) ? geometry : [];
  if (Array.isArray(geometry) && !rows.length) checks.push(issue('unsupported', 'native-empty-selection', { message: 'No nodes were available to verify native field capabilities' }));
  const identity = (row) => record(row?.dataset) ? row.dataset : null;
  if (coherent) {
    coherent = [inline, confirm, ...(computed ? [computed] : [])].every((pass) => pass.length === rows.length);
    if (!coherent) checks.push(issue('unsupported', 'native-sample-count-changed'));
    else for (let index = 0; index < rows.length; index++) {
      if (![inline[index], confirm[index], ...(computed ? [computed[index]] : [])].every((row) => same(identity(rows[index]), identity(row)))) {
        coherent = false;
        checks.push(issue('unsupported', 'native-sample-identity-changed', { index }));
      }
      const a = measuredRect(rows[index]), b = measuredRect(confirm[index]);
      if (!a || !b) {
        coherent = false;
        checks.push(issue('unsupported', 'native-sample-geometry-unreadable', { index }));
      } else if (RECT_KEYS.some((key) => Math.abs(a[key] - b[key]) > 0.01)) {
        coherent = false;
        checks.push(issue('unsupported', 'native-sample-geometry-changed', { index }));
      }
    }
  }
  base.nodes = rows.map((row, index) => {
    const styleRow = coherent ? inline[index] : null, computedRow = coherent && computed ? computed[index] : null;
    const rect = measuredRect(row), dataset = record(row?.dataset) ? row.dataset : null;
    const inlineStyle = styleRow && own(styleRow, 'style') && (typeof styleRow.style === 'string' || record(styleRow.style)) ? styleRow.style : null;
    const styles = {}, properties = {};
    for (const name of spec.computedStyle) if (computedRow && own(computedRow, name) && computedRow[name] != null) styles[name] = computedRow[name];
    for (const name of spec.properties) if (styleRow && own(styleRow, name) && styleRow[name] !== undefined) properties[name] = styleRow[name];
    const node = { index, dataset, rect, inlineStyle, computedStyle: styles, properties,
      sources: { rect: 'wx.createSelectorQuery.fields(rect,size)', dataset: 'wx.createSelectorQuery.fields(dataset)',
        inlineStyle: inlineStyle === null ? null : 'wx.createSelectorQuery.fields(properties.style)', computedStyle: 'wx.createSelectorQuery.fields(computedStyle)' },
      available: { rect: !!rect, dataset: !!dataset, inlineStyle: inlineStyle !== null,
        computedStyle: Object.keys(styles), properties: Object.keys(properties) } };
    if (typeof properties.text === 'string') node.text = properties.text;
    return node;
  });
  if (coherent && rows.length && base.nodes.every((node) => node.rect) && base.nodes.some((node) => node.inlineStyle === null)) {
    let fallback;
    const remaining = spec.timeoutMs - (Date.now() - started);
    try { fallback = remaining > 0
      ? await bounded(fallbackInlineStyles(mp, base.nodes, spec, raw.route), remaining, 'inline-fallback-timeout')
      : { status: 'unsupported', reason: 'inline-fallback-timeout' }; }
    catch (error) { fallback = { status: 'unsupported', reason: error.code || 'inline-fallback-failed', message: String(error.message || error) }; }
    const { styles: fallbackStyles, ...fallbackInfo } = fallback;
    base.inlineStyleFallback = fallbackInfo;
    if (fallback.status === 'passed') base.nodes.forEach((node, index) => {
      if (node.inlineStyle === null) {
        node.inlineStyle = fallbackStyles[index];
        node.available.inlineStyle = true;
        node.sources.inlineStyle = fallback.source;
        if (spec.properties.includes('style')) { node.properties.style = fallbackStyles[index]; node.available.properties.push('style'); }
      }
    });
  }
  base.route = raw.route ?? null;
  base.scope = raw.scope;
  base.viewportRect = measuredRect(raw.viewport);
  if (base.viewportRect && (base.viewportRect.width <= 0 || base.viewportRect.height <= 0)) base.viewportRect = null;
  base.containerRect = spec.containerSelector ? measuredRect(result[slots.container]) : null;
  base.clipRect = spec.containerSelector ? intersect(base.viewportRect, base.containerRect) : base.viewportRect;
  const scroll = own(slots, 'scroll') ? result[slots.scroll] : null;
  if (scroll && finite(scroll.scrollTop) && finite(scroll.scrollLeft)) base.scroll = { scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft };
  const capability = (ok, details = {}) => ({ status: ok ? 'passed' : 'unsupported', ...details });
  base.capabilities = {
    selection: capability(Array.isArray(geometry), { count: Array.isArray(geometry) ? geometry.length : null }),
    rect: capability(rows.length > 0 && base.nodes.every((node) => node.available.rect)),
    dataset: capability(rows.length > 0 && base.nodes.every((node) => node.available.dataset)),
    inlineStyle: capability(rows.length > 0 && base.nodes.every((node) => node.available.inlineStyle), { sources: [...new Set(base.nodes.map((node) => node.sources.inlineStyle).filter(Boolean))] }),
    computedStyle: capability(rows.length > 0 && base.nodes.every((node) => spec.computedStyle.every((name) => own(node.computedStyle, name))), { requested: spec.computedStyle }),
    properties: capability(rows.length > 0 && base.nodes.every((node) => spec.properties.every((name) => own(node.properties, name))), { requested: spec.properties }),
    viewport: capability(!!base.viewportRect), container: capability(!spec.containerSelector || !!base.containerRect),
    scroll: capability(!!base.scroll, { message: raw.scrollError }), consistency: capability(coherent),
  };
  // Empty selection is a real absence, not evidence that its field capabilities work.
  // Assessment with nonempty expectations will fail node-count/node-missing.
  for (const name of ['rect', 'dataset', 'inlineStyle', 'computedStyle', 'properties', 'viewport', 'container']) {
    if (base.capabilities[name].status !== 'passed' && (rows.length || ['viewport', 'container'].includes(name))) {
      checks.push(issue('unsupported', `native-${name}-unreadable`));
    }
  }
  base.consistency = { status: coherent ? 'passed' : 'unsupported', merge: 'same-exec-index-with-dataset-and-geometry-confirmation' };
  return { ...base, status: statusOf(checks), issues: checks };
}

function cssKey(name) { return name.startsWith('--') ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).toLowerCase(); }
function cssMap(value, label) {
  if (typeof value === 'string') {
    const out = {};
    for (const piece of value.split(';')) {
      if (!piece.trim()) continue;
      const colon = piece.indexOf(':');
      if (colon < 1 || !piece.slice(colon + 1).trim()) invalid(`${label} contains an invalid CSS declaration`);
      out[cssKey(piece.slice(0, colon).trim())] = piece.slice(colon + 1).trim();
    }
    return out;
  }
  object(value, label);
  if (!Object.keys(value).length) invalid(`${label} must contain style expectations`);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    nonempty(key, label);
    if (typeof val !== 'string' && !finite(val)) invalid(`${label}.${key} must be a string or finite number`);
    out[cssKey(key)] = val;
  }
  return out;
}
function cssEqual(actual, expected, tolerance) {
  const norm = (value) => String(value).trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',');
  const a = norm(actual), e = norm(expected);
  if (a === e) return true;
  // tolerancePx applies to measured CSS lengths only. Unitless properties such
  // as opacity and z-index must remain exact (0 and 1 are not visually equivalent).
  const pa = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(a), pe = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(e);
  return !!(pa && pe && Math.abs(Number(pa[1]) - Number(pe[1])) <= tolerance);
}
function expectationSpec(options) {
  fields(options, ['expected', 'keyAttribute', 'tolerancePx', 'coverage', 'requireUniqueKeys', 'requireOrder'], 'assessment');
  const spec = { keyAttribute: nonempty(options.keyAttribute ?? 'nodeKey', 'assessment.keyAttribute'),
    tolerancePx: number(options.tolerancePx ?? 1, 'assessment.tolerancePx'),
    requireUniqueKeys: bool(options.requireUniqueKeys ?? true, 'assessment.requireUniqueKeys'),
    requireOrder: bool(options.requireOrder ?? true, 'assessment.requireOrder') };
  if (!Array.isArray(options.expected) || !options.expected.length) invalid('assessment.expected must be a nonempty array');
  spec.expected = options.expected.map((entry, index) => {
    const label = `assessment.expected[${index}]`;
    fields(entry, ['key', 'rect', 'style', 'computedStyle', 'dataset', 'properties', 'text'], label);
    if (!keyValid(entry.key)) invalid(`${label}.key must be a nonempty string or finite number`);
    const out = { ...entry };
    if (own(entry, 'rect')) out.rect = rectSpec(entry.rect, `${label}.rect`, true);
    if (own(entry, 'style')) out.style = cssMap(entry.style, `${label}.style`);
    if (own(entry, 'computedStyle')) {
      if (!record(entry.computedStyle)) invalid(`${label}.computedStyle must be an object`);
      out.computedStyle = cssMap(entry.computedStyle, `${label}.computedStyle`);
    }
    for (const name of ['dataset', 'properties']) if (own(entry, name)) {
      object(entry[name], `${label}.${name}`);
      if (!Object.keys(entry[name]).length) invalid(`${label}.${name} cannot be empty`);
      json(entry[name], `${label}.${name}`);
    }
    if (own(entry, 'text') && typeof entry.text !== 'string') invalid(`${label}.text must be a string`);
    return out;
  });
  if (spec.requireUniqueKeys && new Set(spec.expected.map((entry) => keyToken(entry.key))).size !== spec.expected.length) invalid('assessment.expected contains duplicate business keys');
  if (own(options, 'coverage')) {
    fields(options.coverage, ['axis', 'x', 'top', 'bottom', 'maxGapPx'], 'assessment.coverage');
    if (options.coverage.axis !== 'y') invalid('assessment.coverage.axis must be y');
    spec.coverage = { axis: 'y', maxGapPx: options.coverage.maxGapPx ?? spec.tolerancePx };
    for (const name of ['x', 'top', 'bottom', 'maxGapPx']) if (own(options.coverage, name)) {
      spec.coverage[name] = number(options.coverage[name], `assessment.coverage.${name}`, name === 'maxGapPx' ? 0 : -Infinity);
    }
    if (own(spec.coverage, 'top') && own(spec.coverage, 'bottom') && spec.coverage.bottom <= spec.coverage.top) invalid('coverage.bottom must be greater than coverage.top');
  }
  return spec;
}

function coverageAssessment(nodes, snapshot, spec) {
  const viewport = measuredRect(snapshot.viewportRect), container = snapshot.containerRect ? measuredRect(snapshot.containerRect) : null;
  const clip = container ? intersect(viewport, container) : viewport;
  if (!viewport || (snapshot.containerSelector && !container)) return { check: issue('unsupported', 'coverage-clip-unreadable'), coverage: null };
  if (!clip) return { check: issue('failed', 'coverage-empty-clip'), coverage: null };
  const x = spec.x ?? (clip.left + clip.right) / 2;
  const top = Math.max(clip.top, spec.top ?? clip.top), bottom = Math.min(clip.bottom, spec.bottom ?? clip.bottom);
  const coverage = { axis: 'y', x, top, bottom, clipRect: clip, maxGapPx: spec.maxGapPx, intervals: [], merged: [], gaps: [] };
  if (x < clip.left || x > clip.right || bottom <= top) return { check: issue('failed', 'coverage-probe-outside-clip'), coverage };
  if (nodes.some((node) => !measuredRect(node.rect))) return { check: issue('unsupported', 'coverage-rect-unreadable'), coverage };
  for (const node of nodes) {
    const r = node.rect;
    if (r.width <= 0 || r.height <= 0 || x < r.left || x > r.right) continue;
    const start = Math.max(top, r.top), end = Math.min(bottom, r.bottom);
    if (end > start) coverage.intervals.push([start, end]);
  }
  coverage.intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const interval of coverage.intervals) {
    const prev = coverage.merged[coverage.merged.length - 1];
    if (prev && interval[0] <= prev[1]) prev[1] = Math.max(prev[1], interval[1]);
    else coverage.merged.push([...interval]);
  }
  let cursor = top;
  for (const [start, end] of coverage.merged) {
    if (start > cursor) coverage.gaps.push({ top: cursor, bottom: start, size: start - cursor });
    cursor = Math.max(cursor, end);
  }
  if (cursor < bottom) coverage.gaps.push({ top: cursor, bottom, size: bottom - cursor });
  return { check: issue(coverage.gaps.some((gap) => gap.size > spec.maxGapPx + 1e-9) ? 'failed' : 'passed', 'coverage', { gaps: coverage.gaps, maxGapPx: spec.maxGapPx }), coverage };
}

/** Compare business identity AND actual native measurements, never submitted data. */
export function assessNativeNodes(snapshot, options = {}) {
  const spec = expectationSpec(options), checks = [];
  if (!record(snapshot) || snapshot.source !== 'wx.createSelectorQuery' || snapshot.coordinateSpace !== 'viewport' || !Array.isArray(snapshot.nodes)) {
    return { status: 'unsupported', checks: [], issues: [issue('unsupported', 'native-snapshot-required')], coverage: null };
  }
  if (snapshot.status !== 'passed') checks.push(issue(snapshot.status === 'failed' ? 'failed' : 'unsupported', 'native-probe-not-verified', { probeIssues: snapshot.issues ?? [] }));
  const nodes = snapshot.nodes;
  // An unavailable query is not the same as a measured empty selection. Do not turn
  // the placeholder [] from a failed evaluate into a business node-count failure.
  if (snapshot.status === 'unsupported' && ((!nodes.length && !snapshot.consistency) || snapshot.capabilities?.selection?.status === 'unsupported')) {
    return { status: 'unsupported', coordinateSpace: 'viewport', checks, issues: checks, coverage: null };
  }
  checks.push(issue(nodes.length === spec.expected.length ? 'passed' : 'failed', 'node-count', { expected: spec.expected.length, actual: nodes.length }));
  const unreadableKeys = new Set();
  const actualKeys = nodes.map((node, index) => {
    if (!record(node?.dataset)) { unreadableKeys.add(index); checks.push(issue('unsupported', 'dataset-unreadable', { index })); return undefined; }
    const key = node.dataset[spec.keyAttribute];
    if (!own(node.dataset, spec.keyAttribute) || !keyValid(key)) checks.push(issue('failed', 'business-key-missing', { index, keyAttribute: spec.keyAttribute }));
    return key;
  });
  if (spec.requireUniqueKeys) {
    const seen = new Set();
    actualKeys.forEach((key, index) => {
      if (!keyValid(key)) return;
      if (seen.has(keyToken(key))) checks.push(issue('failed', 'business-key-duplicate', { key, index }));
      seen.add(keyToken(key));
    });
  }
  if (spec.requireOrder) checks.push(issue(unreadableKeys.size ? 'unsupported' : same(actualKeys, spec.expected.map((entry) => entry.key)) ? 'passed' : 'failed', 'business-key-order', { expected: spec.expected.map((entry) => entry.key), actual: actualKeys }));
  const used = new Set();
  for (const expected of spec.expected) {
    const index = actualKeys.findIndex((key, i) => !used.has(i) && same(key, expected.key));
    if (index < 0) { checks.push(issue(unreadableKeys.size ? 'unsupported' : 'failed', 'node-missing', { key: expected.key })); continue; }
    used.add(index);
    const node = nodes[index], details = { key: expected.key, index };
    const actualRect = measuredRect(node.rect);
    if (!actualRect) checks.push(issue('unsupported', 'native-rect-unreadable', details));
    if (expected.rect) for (const [field, value] of Object.entries(expected.rect)) {
      checks.push(issue(!actualRect ? 'unsupported' : Math.abs(actualRect[field] - value) <= spec.tolerancePx ? 'passed' : 'failed', 'rect', { ...details, field, expected: value, actual: actualRect?.[field] ?? null }));
    }
    for (const name of ['style', 'computedStyle']) if (own(expected, name)) {
      let actual = null;
      try {
        if (name === 'style' && node.inlineStyle !== null && node.inlineStyle !== undefined) actual = cssMap(node.inlineStyle, 'native inlineStyle');
        if (name === 'computedStyle' && record(node.computedStyle)) actual = Object.fromEntries(Object.entries(node.computedStyle).map(([key, value]) => [cssKey(key), value]));
      } catch (_) { /* Native unreadable CSS is evidence failure, not a bad user spec. */ }
      if (!actual) checks.push(issue('unsupported', `${name}-unreadable`, details));
      else if (name === 'style' && typeof options.expected[spec.expected.indexOf(expected)].style === 'string') {
        // A declaration string is an exact inline declaration set (order ignored).
        // In particular, an obsolete extra transform cannot hide behind height-only CSS.
        const matches = Object.keys(actual).length === Object.keys(expected[name]).length
          && Object.entries(expected[name]).every(([field, value]) => own(actual, field) && cssEqual(actual[field], value, spec.tolerancePx));
        checks.push(issue(matches ? 'passed' : 'failed', name, { ...details, expected: expected[name], actual }));
      } else for (const [field, value] of Object.entries(expected[name])) {
        const available = own(actual, field) && actual[field] !== null && actual[field] !== undefined;
        // An absent INLINE declaration is a measured mismatch; absent computed properties
        // indicate an unmeasured native capability and must remain unsupported.
        checks.push(issue(!available ? name === 'style' ? 'failed' : 'unsupported' : cssEqual(actual[field], value, spec.tolerancePx) ? 'passed' : 'failed', name,
          { ...details, field, expected: value, actual: available ? actual[field] : null }));
      }
    }
    for (const name of ['dataset', 'properties']) if (expected[name]) for (const [field, value] of Object.entries(expected[name])) {
      const available = record(node[name]) && own(node[name], field);
      checks.push(issue(!available ? 'unsupported' : same(node[name][field], value) ? 'passed' : 'failed', name,
        { ...details, field, expected: value, actual: available ? node[name][field] : null }));
    }
    if (own(expected, 'text')) checks.push(issue(typeof node.text !== 'string' ? 'unsupported' : node.text === expected.text ? 'passed' : 'failed', 'text', { ...details, expected: expected.text, actual: node.text ?? null }));
    if (!spec.coverage && !Object.keys(expected).some((key) => key !== 'key')) checks.push(issue('unsupported', 'native-expectation-unmeasured', details));
  }
  let coverage = null;
  if (spec.coverage) {
    const result = coverageAssessment(nodes, snapshot, spec.coverage);
    checks.push(result.check); coverage = result.coverage;
  }
  return { status: statusOf(checks), coordinateSpace: 'viewport', checks, issues: checks.filter((check) => check.status !== 'passed'), coverage };
}

const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
function pathParts(path, label = 'keyPath') {
  nonempty(path, label);
  if (!/^[A-Za-z_$][\w$]*(?:(?:\.(?:[A-Za-z_$][\w$]*|\d+))|\[\d+\])*$/.test(path)) invalid(`${label} must be a safe dot/numeric-index key path`);
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  if (parts.some((part) => UNSAFE_SEGMENTS.has(part))) invalid(`${label} contains an unsafe property`);
  return parts;
}
/** Safe own-property lookup, no eval, inherited properties or prototype traversal. */
export function readKeyPath(value, path) {
  let current = value;
  for (const part of pathParts(path)) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'string') || !own(current, part)) return { found: false, value: null };
    current = current[part];
  }
  return current === undefined ? { found: false, value: null } : { found: true, value: current };
}

/** Validate JSON specs before doing any I/O. Unknown conditions/fields are errors. */
export function validateReadinessSpec(spec = {}) {
  fields(spec, ['conditions', 'timeoutMs', 'intervalMs', 'maxSamples', 'stableSamples', 'stableWindowMs', 'epsilon'], 'ready');
  const out = { timeoutMs: number(spec.timeoutMs ?? 5000, 'ready.timeoutMs', 1),
    intervalMs: number(spec.intervalMs ?? 100, 'ready.intervalMs', 1),
    maxSamples: number(spec.maxSamples ?? 100, 'ready.maxSamples', 2, true),
    stableSamples: number(spec.stableSamples ?? 3, 'ready.stableSamples', 2, true),
    stableWindowMs: number(spec.stableWindowMs ?? 200, 'ready.stableWindowMs'),
    epsilon: number(spec.epsilon ?? 0.5, 'ready.epsilon') };
  if (out.maxSamples < out.stableSamples) invalid('ready.maxSamples must be >= stableSamples');
  if (out.stableWindowMs > out.timeoutMs) invalid('ready.stableWindowMs must be <= timeoutMs');
  if (!Array.isArray(spec.conditions) || !spec.conditions.length) invalid('ready.conditions must be a nonempty array');
  out.conditions = spec.conditions.map((condition, index) => {
    object(condition, `ready.conditions[${index}]`);
    const label = `ready.conditions[${index}]`, type = condition.type;
    if (type === 'route') {
      fields(condition, ['type', 'equals'], label);
      return { type, equals: nonempty(condition.equals, `${label}.equals`) };
    }
    if (type === 'selector') {
      fields(condition, ['type', 'selector', 'minCount', 'maxCount'], label);
      const item = { type, selector: nonempty(condition.selector, `${label}.selector`), minCount: number(condition.minCount ?? 1, `${label}.minCount`, 0, true) };
      if (own(condition, 'maxCount')) item.maxCount = number(condition.maxCount, `${label}.maxCount`, item.minCount, true);
      return item;
    }
    if (type === 'data') {
      fields(condition, ['type', 'keyPath', 'equals', 'minLength'], label);
      pathParts(condition.keyPath, `${label}.keyPath`);
      if (!own(condition, 'equals') && !own(condition, 'minLength')) invalid(`${label} needs equals and/or minLength`);
      const item = { type, keyPath: condition.keyPath };
      if (own(condition, 'equals')) { json(condition.equals, `${label}.equals`); item.equals = copy(condition.equals); }
      if (own(condition, 'minLength')) item.minLength = number(condition.minLength, `${label}.minLength`, 0, true);
      return item;
    }
    if (type === 'layout' || type === 'scroll') {
      fields(condition, ['type', 'path', 'epsilon'], label);
      const item = { type, path: condition.path ?? type, epsilon: number(condition.epsilon ?? out.epsilon, `${label}.epsilon`) };
      pathParts(item.path, `${label}.path`);
      return item;
    }
    invalid(`${label}.type is unknown`);
  });
  return out;
}

function leaves(value, path = '$', out = new Map(), seen = new Set()) {
  if (finite(value) || typeof value === 'string' || typeof value === 'boolean') { out.set(path, value); return out; }
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  // A measured rect may have empty metadata (dataset:{}). Keep its structural
  // marker while the overall requireNumeric gate still rejects {} / [] alone.
  if (!Object.keys(value).length) { out.set(`${path}/@empty`, Array.isArray(value) ? '[]' : '{}'); return out; }
  seen.add(value);
  for (const key of Object.keys(value).sort()) if (!leaves(value[key], `${path}/${Array.isArray(value) ? 'a' : 'o'}:${JSON.stringify(key)}`, out, seen)) return null;
  seen.delete(value);
  return out;
}
function compareValues(values, epsilon, requireNumeric = true, onlyNumeric = false) {
  const maps = values.map((value) => leaves(value));
  if (maps.some((map) => !map || [...map.keys()].every((path) => path.endsWith('/@empty'))
      || (requireNumeric && ![...map.values()].some(finite))
      || (onlyNumeric && [...map.values()].some((value) => !finite(value))))) {
    return issue('unsupported', 'stability-reading-missing');
  }
  const first = maps[0];
  if (maps.some((map) => map.size !== first.size || [...first.keys()].some((key) => !map.has(key)))) return issue('failed', 'stability-structure-changed');
  for (const [path, initial] of first) {
    const entries = maps.map((map) => map.get(path));
    if (finite(initial) && entries.every(finite)) {
      const range = Math.max(...entries) - Math.min(...entries);
      if (range > epsilon) return issue('failed', 'stability-numeric-range', { path, range, epsilon });
    } else if (!entries.every((value) => Object.is(value, initial))) return issue('failed', 'stability-value-changed', { path });
  }
  return issue('passed', 'stability-values');
}

/** Pure whole-window comparison, not adjacent-pair drift. samples=[{at,value}]. */
export function assessStableSamples(samples, options = {}) {
  fields(options, ['stableSamples', 'stableWindowMs', 'epsilon', 'requireNumeric', 'onlyNumeric'], 'stability');
  const count = number(options.stableSamples ?? 3, 'stability.stableSamples', 1, true);
  const span = number(options.stableWindowMs ?? 200, 'stability.stableWindowMs');
  const epsilon = number(options.epsilon ?? 0.5, 'stability.epsilon');
  const requireNumeric = bool(options.requireNumeric ?? true, 'stability.requireNumeric');
  const onlyNumeric = bool(options.onlyNumeric ?? false, 'stability.onlyNumeric');
  if (!Array.isArray(samples)) invalid('stability.samples must be an array');
  samples.forEach((sample, index) => {
    fields(sample, ['at', 'value'], `stability.samples[${index}]`);
    number(sample.at, `stability.samples[${index}].at`, -Infinity);
    if (index && sample.at < samples[index - 1].at) invalid('stability sample timestamps must be monotonic');
  });
  const spanMs = samples.length ? samples[samples.length - 1].at - samples[0].at : 0;
  const checks = samples.length ? [compareValues(samples.map((sample) => sample.value), epsilon, requireNumeric, onlyNumeric)]
    : [issue('unsupported', 'stability-reading-missing')];
  if (samples.length < count || spanMs < span) checks.push(issue('failed', 'stability-window-incomplete', { sampleCount: samples.length, requiredSamples: count, spanMs, requiredSpanMs: span }));
  // Unavailable readings dominate incomplete windows: absence is not instability evidence.
  const status = checks.some((check) => check.status === 'unsupported') ? 'unsupported' : statusOf(checks);
  return { status, stable: status === 'passed', sampleCount: samples.length, spanMs, checks, issues: checks.filter((check) => check.status !== 'passed') };
}

function readCondition(sample, condition, index) {
  const base = { index, type: condition.type };
  const result = (status, reason, actual, value = actual) => ({ ...base, status, reason, actual, value });
  if (condition.type === 'route') {
    if (typeof sample?.route !== 'string' || !sample.route) return result('unsupported', 'route-unreadable', sample?.route ?? null);
    const route = sample.route.replace(/^\//, ''), expected = condition.equals.replace(/^\//, '');
    return result(route === expected ? 'passed' : 'failed', 'route-equals', sample.route, route);
  }
  if (condition.type === 'selector') {
    const count = sample?.selectors?.[condition.selector];
    if (!own(sample?.selectors, condition.selector) || !Number.isInteger(count) || count < 0) return result('unsupported', 'selector-count-unreadable', count ?? null);
    return result(count >= condition.minCount && (condition.maxCount === undefined || count <= condition.maxCount) ? 'passed' : 'failed', 'selector-count', count);
  }
  if (condition.type === 'data') {
    if (!record(sample?.data) && !Array.isArray(sample?.data)) return result('unsupported', 'data-unreadable', null);
    const reading = readKeyPath(sample.data, condition.keyPath);
    if (!reading.found) return result('failed', 'data-key-missing', null);
    const value = reading.value;
    const equal = !own(condition, 'equals') || same(value, condition.equals);
    const length = typeof value === 'string' || Array.isArray(value) ? value.length : null;
    const longEnough = !own(condition, 'minLength') || (length !== null && length >= condition.minLength);
    return result(equal && longEnough ? 'passed' : 'failed', !equal ? 'data-equals' : 'data-min-length', value);
  }
  const reading = readKeyPath(sample, condition.path);
  if (!reading.found) return result('unsupported', `${condition.type}-unreadable`, null);
  const validity = compareValues([reading.value], condition.epsilon, true, condition.type === 'scroll');
  return result(validity.status, validity.status === 'passed' ? `${condition.type}-reading` : `${condition.type}-unreadable`, reading.value);
}

/** Generic readiness composition. read() must only return actual observed samples. */
export async function waitReady(read, spec, runtime = {}) {
  if (typeof read !== 'function') invalid('waitReady requires a read function');
  const config = validateReadinessSpec(spec);
  fields(runtime, ['now', 'sleep'], 'ready.runtime');
  if (own(runtime, 'now') && typeof runtime.now !== 'function') invalid('ready.runtime.now must be a function');
  if (own(runtime, 'sleep') && typeof runtime.sleep !== 'function') invalid('ready.runtime.sleep must be a function');
  const now = runtime.now ?? Date.now, sleep = runtime.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let sampleCount = 0, lastSample = null, lastReadError = null, lastConditionResults = [], history = [], unmetConditions = [], reason = 'timeout';
  while (sampleCount < config.maxSamples && now() - started < config.timeoutMs) {
    sampleCount++;
    let sample;
    try {
      sample = await bounded(Promise.resolve().then(() => read({ sampleIndex: sampleCount, elapsedMs: now() - started })), Math.max(1, config.timeoutMs - (now() - started)), 'ready-read-timeout');
      json(sample, 'ready sample');
      if (!record(sample)) throw new Error('Ready reader must return a JSON object');
      sample = copy(sample); lastSample = sample; lastReadError = null;
    } catch (error) {
      sample = undefined;
      lastReadError = { code: error.code || 'ready-read-failed', message: String(error.message || error) };
      unmetConditions = config.conditions.map((condition, index) => ({ index, type: condition.type, status: 'unsupported',
        reason: 'ready-read-unavailable', readErrorCode: lastReadError.code }));
      history = [];
      if (error.code === 'ready-read-timeout') break;
    }
    if (sample) {
      const observed = config.conditions.map((condition, index) => readCondition(sample, condition, index));
      lastConditionResults = observed.map(({ value, ...condition }) => condition);
      unmetConditions = lastConditionResults.filter((condition) => condition.status !== 'passed');
      if (unmetConditions.length) history = [];
      else {
        history.push({ at: now(), values: observed.map((condition) => condition.value) });
        const changed = config.conditions.some((condition, index) => ['layout', 'scroll'].includes(condition.type)
          ? compareValues(history.map((entry) => entry.values[index]), condition.epsilon, true, condition.type === 'scroll').status !== 'passed'
          : history.some((entry) => !same(entry.values[index], history[0].values[index])));
        if (changed) history = [history[history.length - 1]];
        const spanMs = history[history.length - 1].at - history[0].at;
        if (history.length >= config.stableSamples && spanMs >= config.stableWindowMs && now() - started < config.timeoutMs) {
          return { status: 'passed', ready: true, sampleCount, elapsedMs: now() - started, lastSample,
            unmetConditions: [], lastReadError: null, lastConditionResults, window: { sampleCount: history.length, spanMs } };
        }
        unmetConditions = config.conditions.map((condition, index) => ({ index, type: condition.type, status: 'failed', reason: 'stable-window-incomplete',
          sampleCount: history.length, requiredSamples: config.stableSamples, spanMs, requiredSpanMs: config.stableWindowMs }));
      }
    }
    if (sampleCount >= config.maxSamples) { reason = 'max-samples'; break; }
    const remaining = config.timeoutMs - (now() - started);
    if (remaining > 0) await sleep(Math.min(config.intervalMs, remaining));
  }
  return { status: unmetConditions.some((condition) => condition.status === 'unsupported') ? 'unsupported' : 'failed', ready: false,
    reason, sampleCount, elapsedMs: now() - started, lastSample, lastReadError, lastConditionResults, unmetConditions,
    window: { sampleCount: history.length, spanMs: history.length ? history[history.length - 1].at - history[0].at : 0 } };
}
