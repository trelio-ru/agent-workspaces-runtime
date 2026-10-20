/** Closed rendered-text boundary for signed providers that explicitly opt in.
 * Revalidate the extension response outside the renderer, enforcing a closed
 * schema and byte budget. Site text is untrusted data, never instructions.
 */
export const TEXT_KIND = 'trelio.browser-text/v1';
const fail = () => { throw new Error('VISUAL_RESULT_INVALID'); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const string = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v);
export function validateTextResult(v) {
  if (!exact(v, ['kind', 'state', 'reason', 'sessionId', 'frameId', 'width', 'height', 'scroll', 'title', 'text', 'controls', 'nextOffset', 'scanLimited']) || v.kind !== TEXT_KIND || v.state !== 'ready' || v.reason !== 'none') fail();
  for (const key of ['sessionId', 'frameId']) if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v[key])) fail();
  for (const key of ['width', 'height']) if (!Number.isInteger(v[key]) || v[key] < 1 || v[key] > 8192) fail();
  if (!exact(v.scroll, ['up', 'down', 'left', 'right']) || Object.values(v.scroll).some(x => typeof x !== 'boolean')) fail();
  if (!string(v.title, 240) || !string(v.text, 6000) || typeof v.scanLimited !== 'boolean' || (v.nextOffset !== null && (!Number.isInteger(v.nextOffset) || v.nextOffset < 1 || v.nextOffset > 106_000))) fail();
  if (!Array.isArray(v.controls) || v.controls.length > 40) fail();
  for (const c of v.controls) if (!exact(c, ['role', 'label', 'x', 'y']) || !['link', 'button', 'textbox', 'select'].includes(c.role) || !string(c.label, 120) || !Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.x >= v.width || c.y < 0 || c.y >= v.height) fail();
  if (Buffer.byteLength(JSON.stringify(v)) > 40_000) fail();
  return v;
}
