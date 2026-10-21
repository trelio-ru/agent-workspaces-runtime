const fault = code => Object.assign(new Error(code), { code });
const sourcePath = /\.(?:js|mjs|css|json|map|xml|txt|pdf|wasm|zip|exe|dmg)$/iu;

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Classify received attachment bytes locally, never from a suggested name.
 * No file is executed, extracted, parsed by Office or rendered as HTML here.
 * Original bytes remain intact; the model receives a local file receipt only.
 */
export function visualAttachmentFormat(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw fault('attachment_too_large');
  const starts = hex => bytes.subarray(0, hex.length / 2).toString('hex') === hex;
  const generic = mimeType === 'application/octet-stream';
  const accept = (mime, extension) => {
    if (!generic && mimeType !== mime) throw fault('attachment_unsupported');
    return { mimeType: mime, extension };
  };
  if (bytes.subarray(0, 5).toString() === '%PDF-' && /%%EOF\s*$/u.test(bytes.subarray(-1024).toString('latin1'))) return accept('application/pdf', 'pdf');
  if (starts('89504e470d0a1a0a')) return accept('image/png', 'png');
  if (starts('ffd8ff') && bytes.subarray(-2).toString('hex') === 'ffd9') return accept('image/jpeg', 'jpg');
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) && bytes.at(-1) === 0x3b) return accept('image/gif', 'gif');
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return accept('image/webp', 'webp');
  if (starts('49492a00') || starts('4d4d002a')) return accept('image/tiff', 'tiff');
  if (starts('424d') && bytes.length >= 26 && bytes.readUInt32LE(2) === bytes.length) return accept('image/bmp', 'bmp');
  // Legacy compound Office documents are delivered as data, never opened in
  // the installed Office application. Macro execution is not a download API.
  if (starts('d0cf11e0a1b11e1')) {
    const extension = { 'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt' }[mimeType];
    if (extension) return { mimeType, extension };
  }
  if (starts('504b0304')) {
    // Validate bounded ZIP directory metadata without decompressing a single
    // entry. Reject traversal, encryption, symlinks, ZIP64 and bomb-sized
    // declarations even though this API never extracts the archive itself.
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw fault('attachment_unsupported');
    const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
    if (!count || count > 5000 || bytes.readUInt16LE(end + 8) !== count || start + size !== end) throw fault('attachment_unsupported');
    const names = new Set(); let offset = start, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw fault('attachment_unsupported');
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), packed = bytes.readUInt32LE(offset + 20), unpacked = bytes.readUInt32LE(offset + 24);
      const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42), attrs = bytes.readUInt32LE(offset + 38);
      const next = offset + 46 + length + extra + comment;
      if (next > end || flags & 1 || ![0, 8].includes(method) || packed === 0xffffffff || unpacked === 0xffffffff || (expanded += unpacked) > 200 * 1024 * 1024 || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || ((attrs >>> 16) & 0xf000) === 0xa000) throw fault('attachment_unsupported');
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + length), name = nameBytes.toString('utf8');
      if (!length || length > 1024 || !Buffer.from(name).equals(nameBytes) || /[\x00-\x1f\\:]/u.test(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.') || names.has(name)) throw fault('attachment_unsupported');
      const localLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
      if (local + 30 + localLength + localExtra + packed > start || !bytes.subarray(local + 30, local + 30 + localLength).equals(nameBytes)) throw fault('attachment_unsupported');
      names.add(name); offset = next;
    }
    if (offset !== end) throw fault('attachment_unsupported');
    const office = {
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['word/document.xml', 'docx'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xl/workbook.xml', 'xlsx'],
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['ppt/presentation.xml', 'pptx'],
    }[mimeType];
    if (office && names.has('[Content_Types].xml') && names.has(office[0])) return { mimeType, extension: office[1] };
    const odf = { 'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.spreadsheet': 'ods', 'application/vnd.oasis.opendocument.presentation': 'odp' }[mimeType];
    if (odf && names.has('mimetype') && names.has('content.xml')) return { mimeType, extension: odf };
    if (generic || ['application/zip', 'application/x-zip-compressed'].includes(mimeType)) return { mimeType: 'application/zip', extension: 'zip' };
  }
  if (['text/plain', 'text/csv', 'application/rtf', 'text/rtf'].includes(mimeType) && bytes.length <= 2 * 1024 * 1024) {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text) || /^\s*(?:<!doctype\s+html|<html\b|<script\b|<\?xml)/iu.test(text)) throw fault('attachment_unsupported');
    if (mimeType.endsWith('rtf') && !text.startsWith('{\\rtf')) throw fault('attachment_unsupported');
    return { mimeType, extension: mimeType === 'text/csv' ? 'csv' : mimeType.endsWith('rtf') ? 'rtf' : 'txt' };
  }
  throw fault('attachment_unsupported');
}

export function createVisualOriginPolicy({ origins, domains = [], allowLoopback = false }) {
  if (!Array.isArray(origins) || !origins.length || origins.length > 16 || !Array.isArray(domains) || domains.length > 8) throw fault('invalid_input');
  const exact = new Set(origins.map(value => {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw fault('invalid_input');
    return value;
  }));
  if (domains.some(value => !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(value))) throw fault('invalid_input');
  const allowsOrigin = raw => {
    try { const url = new URL(raw); return exact.has(url.origin) || (url.protocol === 'https:' && !url.port && domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))); }
    catch { return false; }
  };
  return Object.freeze({
    fixtureOnly: allowLoopback && domains.length === 0 && [...exact].every(value => new URL(value).hostname === '127.0.0.1'),
    allowsOrigin,
    allowsCookie(domain) { const host = domain.replace(/^\./u, ''); return domains.some(root => host === root || host.endsWith(`.${root}`)) || [...exact].some(value => new URL(value).hostname === host); },
    navigate(raw) {
      try {
        const url = new URL(raw);
        if (!allowsOrigin(raw) || url.username || url.password || sourcePath.test(decodeURIComponent(url.pathname))) throw fault('navigation_blocked');
        return url.href;
      } catch { throw fault('navigation_blocked'); }
    },
  });
}
