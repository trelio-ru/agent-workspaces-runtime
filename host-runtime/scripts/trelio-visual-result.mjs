import { validateTextResult, TEXT_KIND } from './trelio-browser-text.mjs';
import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import path from 'node:path';
import { BROWSER_MAIL_REQUEST_KIND, parseBrowserMailHandle } from './trelio-browser-session.mjs';
import { validVisualUploadFiles } from './trelio-visual-uploads.mjs';

// A browser picture is a binary MCP block, never a base64 string in an ordinary
// text result. This boundary is provider-neutral and accepts no page prose,
// paths, HTML, URLs, headers, selectors or arbitrary structured payloads.
export const VISUAL_RESULT_KIND = 'trelio.visual-browser/v1';
export const BROWSER_FILE_KIND = 'trelio.browser-file/v1';
export const MAX_VISUAL_PNG_BYTES = 2 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const states = new Set(['not_configured', 'preparing', 'manual_input_required', 'saved_unverified', 'ready', 'closed', 'error']);
const reasons = new Set(['none', 'manual_control_active', 'stale_frame', 'navigation_blocked', 'document_blocked', 'lease_expired', 'operation_failed', 'bootstrap_failed', 'storage_unavailable', 'storage_corrupt', 'session_busy', 'session_closed', 'browser_process_lost', 'invalid_input', 'http_document_failure', 'request_not_reviewed', 'request_not_ready', 'observation_mode_mismatch', 'tab_limit_reached', 'attachment_unsupported', 'attachment_too_large', 'attachment_link_required', 'attachment_limit_reached']);
for (const reason of ['upload_file_invalid', 'upload_file_changed', 'upload_too_large', 'upload_limit_reached', 'upload_control_required', 'upload_timed_out']) reasons.add(reason);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
for (const reason of ['authentication_required', 'authentication_setup_required', 'authentication_unknown', 'authentication_cancelled', 'authentication_timeout', 'authentication_setup_failed', 'authentication_mail_busy']) reasons.add(reason);
const fail = () => { const error = new Error('VISUAL_RESULT_INVALID'); error.code = 'VISUAL_RESULT_INVALID'; throw error; };

function validatePng(bytes, discardBrowserColorProfile = false) {
  // Accept the raster/color chunks Chromium emits, not arbitrary PNG text,
  // EXIF, embedded files or appended bytes. The MCP boundary never treats a
  // header plus arbitrary source text as an image. CRCs also reject truncation.
  let offset = 8, data = false, ended = false, chunks = 0, palette = false, colorProfile = false;
  const retained = discardBrowserColorProfile ? [bytes.subarray(0, 8)] : null;
  while (offset < bytes.length && ++chunks <= 4096) {
    if (offset + 12 > bytes.length) fail();
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    const discard = discardBrowserColorProfile && type === 'iCCP';
    if (length > bytes.length - offset - 12 || (!discard && !['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'PLTE', 'tRNS'].includes(type))) fail();
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) fail();
    if (chunks === 1 ? type !== 'IHDR' || length !== 13 : type === 'IHDR') fail();
    if (discard) {
      // Chromium may tag its own screenshot with the display's ICC profile.
      // It is ancillary metadata, not raster data. Discard the bounded chunk
      // without decompressing, logging or exposing its name/profile bytes.
      // Do not admit iCCP at ordinary MCP/provider validation boundaries:
      // only the owned browser capture path may perform this normalization.
      const profile = bytes.subarray(offset + 8, offset + 8 + length);
      const nameEnd = profile.indexOf(0);
      if (colorProfile || data || palette || length > 64 * 1024 || nameEnd < 1 || nameEnd > 79
        || nameEnd + 2 >= profile.length || profile[nameEnd + 1] !== 0
        || profile.subarray(0, nameEnd).some(value => value < 32 || (value > 126 && value < 161))) fail();
      colorProfile = true;
    }
    if (type === 'PLTE') palette = true;
    if (type === 'IDAT') data = true;
    if (type === 'IEND') { if (length || !data) fail(); ended = true; }
    if (retained && !discard) retained.push(bytes.subarray(offset, offset + 12 + length));
    offset += 12 + length;
    if (ended) break;
  }
  if (!ended || offset !== bytes.length) fail();
  // Validate every chunk and the complete original container before returning
  // any replacement. CRCs and raster bytes are preserved byte for byte; text,
  // EXIF, unknown chunks, trailing bytes and malformed profile framing fail.
  return colorProfile ? Buffer.concat(retained) : bytes;
}

function validateResult(value, discardBrowserColorProfile) {
  if (!exact(value, ['kind', 'state', 'reason', 'sessionId', 'frameId', 'width', 'height', 'scroll', 'image', 'hasStoredSession', 'httpStatus', 'origin']) || value.kind !== VISUAL_RESULT_KIND || !states.has(value.state) || !reasons.has(value.reason)) fail();
  if (value.reason === 'http_document_failure') {
    let url;
    try { url = new URL(value.origin); } catch { fail(); }
    if (value.state !== 'error' || !Number.isInteger(value.httpStatus) || value.httpStatus < 400 || value.httpStatus > 599 || url.protocol !== 'https:' || url.origin !== value.origin || url.username || url.password || url.port) fail();
  } else if (value.httpStatus !== undefined || value.origin !== undefined) fail();
  if (value.sessionId !== undefined && !uuid.test(value.sessionId)) fail();
  if (value.hasStoredSession !== undefined && typeof value.hasStoredSession !== 'boolean') fail();
  const hasImage = value.image !== undefined;
  if (hasImage) {
    if (value.state !== 'ready' || value.reason !== 'none' || !uuid.test(value.frameId) || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 320 || value.width > 1920 || value.height < 240 || value.height > 1440) fail();
    if (!exact(value.scroll, ['up', 'down', 'left', 'right']) || ['up', 'down', 'left', 'right'].some(key => typeof value.scroll[key] !== 'boolean')) fail();
    if (!exact(value.image, ['mimeType', 'data']) || value.image.mimeType !== 'image/png' || typeof value.image.data !== 'string' || value.image.data.length > Math.ceil(MAX_VISUAL_PNG_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.image.data)) fail();
    const bytes = Buffer.from(value.image.data, 'base64');
    if (bytes.length < 33 || bytes.length > MAX_VISUAL_PNG_BYTES || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== value.width || bytes.readUInt32BE(20) !== value.height) fail();
    const normalized = validatePng(bytes, discardBrowserColorProfile);
    if (normalized !== bytes) return { ...value, image: { ...value.image, data: normalized.toString('base64') } };
  } else if (['frameId', 'width', 'height', 'scroll'].some(key => value[key] !== undefined)) fail();
  return value;
}

export function validateVisualResult(value) {
  if (value?.kind === BROWSER_MAIL_REQUEST_KIND) {
    if (!exact(value, ['kind', 'state', 'handle', 'expiresAt', 'authenticated', 'acknowledgement'])
      || !['waiting', 'finished'].includes(value.state) || !Number.isSafeInteger(value.expiresAt)
      || typeof value.authenticated !== 'boolean' || !['none', 'pending', 'complete', 'unknown'].includes(value.acknowledgement)) fail();
    try { parseBrowserMailHandle(value.handle); } catch { fail(); }
    return value;
  }
  if (value?.kind === BROWSER_FILE_KIND) {
    if (!exact(value, ['kind', 'state', 'reason', 'sessionId', 'filePath', 'sizeBytes', 'sha256', 'mimeType', 'expiresAt']) || value.state !== 'ready' || value.reason !== 'none' || !uuid.test(value.sessionId)
      || typeof value.filePath !== 'string' || value.filePath.length > 4096 || !path.isAbsolute(value.filePath) || /[\x00-\x1f]/u.test(value.filePath)
      || !Number.isInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 20 * 1024 * 1024 || !/^[0-9a-f]{64}$/u.test(value.sha256)
      || typeof value.mimeType !== 'string' || value.mimeType.length > 128 || !/^(?:image\/(?:png|jpeg|gif|webp|tiff|bmp)|text\/(?:plain|csv|rtf)|application\/(?:pdf|rtf|zip|msword|vnd\.ms-(?:excel|powerpoint)|vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|vnd\.oasis\.opendocument\.(?:text|spreadsheet|presentation)))$/u.test(value.mimeType)
      || !Number.isSafeInteger(value.expiresAt)) fail();
    return value;
  }
  return value?.kind === TEXT_KIND ? validateTextResult(value) : validateResult(value, false);
}

/** Normalize only a host-owned raster capture, before it enters the private
 * worker HTTP transport and ordinary strict MCP validation. No website code,
 * metadata text or color-profile payload crosses the image-only boundary.
 * Removing the ancillary ICC tag leaves raster samples unchanged; consumers
 * render them in their default color space rather than receiving the profile.
 */
export function normalizeBrowserVisualResult(value) { return validateResult(value, true); }

export function visualStatus(state, reason = 'none', extra = {}) {
  return validateVisualResult({ kind: VISUAL_RESULT_KIND, state, reason, ...extra });
}

export function visualFrame({ sessionId, width, height, scroll, png }) {
  return validateVisualResult({ kind: VISUAL_RESULT_KIND, state: 'ready', reason: 'none', sessionId, frameId: randomUUID(), width, height, scroll, image: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } });
}

export function visualMcpResult(value) {
  validateVisualResult(value);
  const { image, kind, ...metadata } = value;
  const result = { ...(value.state === 'error' ? { isError: true } : {}), content: [
    { type: 'text', text: JSON.stringify(metadata) },
    ...(image ? [{ type: 'image', mimeType: image.mimeType, data: image.data }] : []),
  ] };
  // MCP serializes the JSON text a second time. Quotes/backslashes can expand
  // even a valid bounded observation beyond the envelope budget; reject it,
  // never truncate or fall back to echoing the original provider stdout.
  if (kind === TEXT_KIND && Buffer.byteLength(JSON.stringify(result)) > 40_000) fail();
  return result;
}

// Only the skill-run transport may interpret this marker. A malformed visual
// attempt fails closed instead of falling back to echoing its original stdout.
export function parseVisualSkillOutput(stdout) {
  if (typeof stdout !== 'string' || (!stdout.includes(VISUAL_RESULT_KIND) && !stdout.includes(TEXT_KIND) && !stdout.includes(BROWSER_FILE_KIND) && !stdout.includes(BROWSER_MAIL_REQUEST_KIND))) return null;
  if (Buffer.byteLength(stdout) > 3 * 1024 * 1024) fail();
  let value;
  try { value = JSON.parse(stdout); } catch { fail(); }
  // Ordinary provider data may mention the protocol in prose. Only its exact
  // top-level marker opts into closed browser projection; legacy JSON stays unchanged.
  if (value?.kind !== VISUAL_RESULT_KIND && value?.kind !== TEXT_KIND && value?.kind !== BROWSER_FILE_KIND && value?.kind !== BROWSER_MAIL_REQUEST_KIND) return null;
  return validateVisualResult(value);
}

// Value-free command schemas shared by the public controller and browser.
// Reject unknown fields BEFORE private owner state or worker creation.
const fields = { status: [], ready: [], 'show-login': [], screenshot: [], 'read-text': ['query', 'offset', 'includeControls'], submit: ['action', 'frameId', 'x', 'y', 'key', 'url'], 'request-ready': ['frameId'], setup: ['url'], navigate: ['url'], click: ['frameId', 'x', 'y'], 'download-attachment': ['frameId', 'x', 'y'], scroll: ['frameId', 'x', 'y', 'deltaY', 'deltaX'], 'type-text': ['frameId', 'text'], key: ['frameId', 'key'] };
fields['upload-files'] = ['frameId', 'x', 'y', 'files'];
export const validVisualArguments = (operation, args) => Object.hasOwn(fields, operation) && args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => fields[operation].includes(key)) && Buffer.byteLength(JSON.stringify(args)) <= 32_768
  && (operation !== 'authenticate-mail' || Object.keys(args).length === 1 && typeof args.mailAccountId === 'string' && uuid.test(args.mailAccountId))
  && (operation !== 'upload-files' || validVisualUploadFiles(args.files) && typeof args.frameId === 'string' && Number.isInteger(args.x) && Number.isInteger(args.y));
for (const operation of ['credentials-setup', 'credentials-status', 'credentials-forget', 'authenticate']) fields[operation] = [];
fields['authenticate-mail'] = ['mailAccountId'];
