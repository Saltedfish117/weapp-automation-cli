/**
 * Element introspection helpers: normalise an Element handle into plain JSON.
 */

/**
 * @param {any} el element handle from page.$()
 * @param {{styles?: string[], wxml?: boolean}} [options]
 */
export async function describeElement(el, options = {}) {
  const styles = options.styles ?? [];
  const [size, offset, text] = await Promise.all([
    el.size().catch(() => null),
    el.offset().catch(() => null),
    el.text().catch(() => null),
  ]);

  /** @type {Record<string, unknown>} */
  const out = {
    tagName: el.tagName ?? null,
    size,
    offset,
    text: typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 500) : text,
    value: await el.value().catch(() => null),
    className: await el.attribute('class').catch(() => null),
  };

  if (styles.length) {
    out.styles = {};
    for (const name of styles) {
      out.styles[name] = await el.style(name).catch(() => null);
    }
  }

  if (options.wxml) {
    out.wxml = await el.wxml().catch(() => null);
  }

  return out;
}

/** Numeric width/height from automator's string sizes. */
export function toBox(size, offset) {
  if (!size || !offset) return null;
  return {
    left: Number.parseFloat(offset.left),
    top: Number.parseFloat(offset.top),
    width: Number.parseFloat(size.width),
    height: Number.parseFloat(size.height),
  };
}
