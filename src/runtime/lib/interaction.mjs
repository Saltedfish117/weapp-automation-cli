import { CliError, EXIT } from './output.mjs';
import { describeElement } from './selectors.mjs';

export async function queryRoot(page, within) {
  if (!within) return page;
  const containers = await page.$$(within);
  if (containers.length !== 1) {
    throw new CliError(`container ${within} must match exactly one element (matched ${containers.length})`, {
      exitCode: EXIT.ASSERT, code: containers.length ? 'ambiguous-container' : 'element-not-found',
      data: { within, count: containers.length },
    });
  }
  return containers[0];
}

export async function chooseElement(root, selector, { index = null, strict = false } = {}) {
  const elements = await root.$$(selector);
  if (!elements.length) {
    throw new CliError(`element not found: ${selector}`, {
      exitCode: EXIT.ASSERT, code: 'element-not-found', data: { selector, count: 0 },
    });
  }
  if (index !== null && (!Number.isInteger(index) || index < 0)) {
    throw new CliError('index must be a non-negative integer', { exitCode: EXIT.CONFIG, code: 'bad-number' });
  }
  if (index !== null && index >= elements.length) {
    throw new CliError(`index ${index} is outside ${elements.length} matches`, {
      exitCode: EXIT.ASSERT, code: 'index-out-of-range', data: { selector, count: elements.length, index },
    });
  }
  if (strict && index === null && elements.length !== 1) {
    throw new CliError(`strict target ${selector} is ambiguous (${elements.length} matches); use --within or --index`, {
      exitCode: EXIT.ASSERT, code: 'ambiguous-target',
      data: { selector, count: elements.length, candidates: await Promise.all(elements.slice(0, 5).map(el => describeElement(el))) },
    });
  }
  return {
    element: elements[index ?? 0], count: elements.length, index: index ?? 0,
    warning: !strict && index === null && elements.length > 1
      ? `${elements.length} matches; first selected. Use --strict or --within to avoid accidental actions.` : null,
  };
}

/** Text is rendered text, not proof of visibility or a click handler. */
export async function textMatches(root, query, { exact = false, tag = null, maxScanned = 1500 } = {}) {
  const tags = tag ? [tag] : ['text', 'button', 'view'];
  const normalizedQuery = String(query).replace(/\s+/g, ' ').trim();
  const matches = [];
  const seen = new Set();
  let scanned = 0;
  let incomplete = false;
  for (const tagName of tags) {
    const elements = await root.$$(tagName);
    for (const element of elements) {
      if (scanned >= maxScanned) { incomplete = true; break; }
      scanned++;
      const text = String(await element.text() ?? '').replace(/\s+/g, ' ').trim();
      if (!text || (exact ? text !== normalizedQuery : !text.includes(normalizedQuery))) continue;
      const [size, offset] = await Promise.all([element.size(), element.offset()]);
      const width = Number.parseFloat(size?.width), height = Number.parseFloat(size?.height);
      const left = Number.parseFloat(offset?.left), top = Number.parseFloat(offset?.top);
      if (![width, height, left, top].every(Number.isFinite) || width <= 0 || height <= 0) continue;
      // Only identical SDK handle identity is safe to deduplicate. Equal text
      // and rectangles may belong to distinct overlapping controls.
      if (seen.has(element)) continue;
      seen.add(element);
      matches.push({ element, tagName, text, size: { width, height }, offset: { left, top },
        className: await element.attribute('class').catch(() => null), area: width * height });
    }
    if (incomplete) break;
  }
  const priority = { text: 0, button: 1, view: 2 };
  matches.sort((a, b) => (priority[a.tagName] ?? 9) - (priority[b.tagName] ?? 9) || a.area - b.area || a.offset.top - b.offset.top || a.offset.left - b.offset.left);
  return { matches, scanned, incomplete, maxScanned };
}

export function selectTextMatch(scan, { index = null, strict = false, query } = {}) {
  if (strict && scan.incomplete) {
    throw new CliError('text scan was incomplete; uniqueness cannot be established', {
      exitCode: EXIT.ASSERT, code: 'incomplete-target-scan', data: { scanned: scan.scanned, maxScanned: scan.maxScanned },
    });
  }
  const matches = scan.matches;
  if (!matches.length) throw new CliError(`no element text matched: ${query}`, { exitCode: EXIT.ASSERT, code: 'element-not-found' });
  // Geometry alone cannot prove ancestry or event ownership. Strict mode
  // keeps all matches; callers must choose a tag/container/index explicitly.
  const targets = matches;
  if (strict && index === null && targets.length !== 1) {
    throw new CliError(`text ${query} is ambiguous (${targets.length} separate targets)`, {
      exitCode: EXIT.ASSERT, code: 'ambiguous-target',
      data: { text: query, count: targets.length, candidates: targets.slice(0, 5).map(({ element, ...rest }) => rest) },
    });
  }
  const actualIndex = index ?? 0;
  if (!Number.isInteger(actualIndex) || actualIndex < 0 || actualIndex >= targets.length) {
    throw new CliError(`text index ${actualIndex} is out of range`, { exitCode: EXIT.ASSERT, code: 'index-out-of-range', data: { count: targets.length, index: actualIndex } });
  }
  return { match: targets[actualIndex], count: targets.length, index: actualIndex,
    warning: !strict && (matches.length > 1 || scan.incomplete) ? 'Heuristic text target selected; use --exact --strict --within and verify business state.' : null };
}
