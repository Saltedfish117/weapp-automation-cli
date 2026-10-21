// Run from your mini-program project:
// weapp run /path/to/examples/read-only.mjs --project . --attach-only
export default async function (ctx) {
  const page = await ctx.page();
  ctx.assert(page, 'No current simulator page');
  const viewport = await page.size();
  ctx.assert(viewport.width > 0 && viewport.height > 0, 'Viewport is not ready');
  const state = await page.data();
  return { path: page.path, viewport, dataKeys: Object.keys(state ?? {}), businessVerified: false };
}
