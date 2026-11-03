const fault = code => Object.assign(new Error(code), { code });
const sourcePath = /\.(?:js|mjs|css|json|map|xml|txt|pdf|wasm|zip|exe|dmg)$/iu;

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Audio is a separate signed disclosure path. A server name or audio MIME is
 * not evidence: recognize the bounded original container before publishing a
 * local receipt. This is format validation, not decoding or an antivirus scan.
 * In particular, never fall back to exporting an HTML/JSON response as text.
 */
export function visualAudioFormat(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw fault('attachment_too_large');
  const reject = () => { throw fault('attachment_unsupported'); };
  const accept = (mime, extension, aliases = []) => {
    if (mimeType !== 'application/octet-stream' && ![mime, ...aliases].includes(mimeType)) reject();
    return { mimeType: mime, extension };
  };
  const text = (start, end) => bytes.subarray(start, end).toString('latin1');
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WAVE') {
    if (bytes.length < 44 || bytes.readUInt32LE(4) + 8 !== bytes.length) reject();
    let offset = 12, format = false, data = false;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) reject();
      const size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size;
      if (end > bytes.length) reject();
      if (text(offset, offset + 4) === 'fmt ') format ||= size >= 16;
      if (text(offset, offset + 4) === 'data') data ||= size > 0;
      offset = end + (size & 1);
    }
    if (offset !== bytes.length || !format || !data) reject();
    return accept('audio/wav', 'wav', ['audio/x-wav', 'audio/wave']);
  }
  if (text(0, 4) === 'OggS') {
    let offset = 0, serial, first = true, opus = false;
    while (offset < bytes.length) {
      if (offset + 27 > bytes.length || text(offset, offset + 4) !== 'OggS' || bytes[offset + 4] !== 0) reject();
      const segments = bytes[offset + 26], start = offset + 27 + segments;
      if (!segments || start > bytes.length) reject();
      let size = 0;
      for (let i = offset + 27; i < start; i++) size += bytes[i];
      if (start + size > bytes.length) reject();
      const pageSerial = bytes.readUInt32LE(offset + 14);
      if (first) {
        serial = pageSerial;
        opus = size >= 19 && text(start, start + 8) === 'OpusHead';
        if (!opus && !(size >= 30 && text(start, start + 7) === '\x01vorbis')) reject();
        first = false;
      } else if (pageSerial !== serial) reject(); // No unrelated multiplexed streams.
      offset = start + size;
    }
    return accept('audio/ogg', opus ? 'opus' : 'ogg', opus ? ['audio/opus', 'application/ogg'] : ['application/ogg']);
  }
  if (text(0, 4) === 'fLaC') {
    let offset = 4, last = false, blocks = 0;
    while (!last) {
      if (offset + 4 > bytes.length || ++blocks > 128) reject();
      const type = bytes[offset] & 127, size = bytes.readUIntBE(offset + 1, 3);
      last = Boolean(bytes[offset] & 128);
      if ((blocks === 1 && (type !== 0 || size !== 34)) || type === 127 || offset + 4 + size > bytes.length) reject();
      offset += 4 + size;
    }
    if (offset >= bytes.length) reject();
    return accept('audio/flac', 'flac', ['audio/x-flac']);
  }
  // ISO BMFF: inspect only bounded box headers/handler metadata, never decode
  // samples. Require an actual audio track and data; an ftyp/video or a file
  // containing the word 'soun' in arbitrary payload is not an audio original.
  if (text(4, 8) === 'ftyp') {
    let audio = false, video = false, data = false, boxes = 0;
    const walk = (start, end, depth) => {
      if (depth > 4) reject();
      for (let offset = start; offset < end;) {
        if (offset + 8 > end || ++boxes > 4096) reject();
        let size = bytes.readUInt32BE(offset), header = 8;
        if (size === 1) { if (offset + 16 > end) reject(); const wide = bytes.readBigUInt64BE(offset + 8); if (wide > BigInt(bytes.length)) reject(); size = Number(wide); header = 16; }
        if (size === 0) size = end - offset;
        if (size < header || offset + size > end) reject();
        const type = text(offset + 4, offset + 8), body = offset + header;
        if (['moov', 'trak', 'mdia'].includes(type)) walk(body, offset + size, depth + 1);
        if (type === 'hdlr' && depth === 3 && size >= header + 12) { audio ||= text(body + 8, body + 12) === 'soun'; video ||= text(body + 8, body + 12) === 'vide'; }
        if (type === 'mdat' && depth === 0) data ||= size > header;
        offset += size;
      }
    };
    if (bytes.length < 24 || bytes.readUInt32BE(0) < 16) reject();
    walk(0, bytes.length, 0);
    if (!audio || video || !data) reject();
    return accept('audio/mp4', 'm4a', ['audio/x-m4a']);
  }
  // MPEG Layer III and ADTS are sequences of complete frames. ID3's bounded
  // synchsafe length is skipped, never interpreted as speech or site content.
  let offset = 0, count = 0;
  if (text(0, 3) === 'ID3') {
    if (bytes.length < 10 || [6, 7, 8, 9].some(i => bytes[i] & 128)) reject();
    offset = 10 + bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 + bytes[9] + ((bytes[5] & 16) ? 10 : 0);
  }
  const adts = offset + 7 <= bytes.length && bytes[offset] === 255 && (bytes[offset + 1] & 246) === 240;
  while (offset + (adts ? 7 : 4) <= bytes.length) {
    if (!adts && bytes.length - offset === 128 && text(offset, offset + 3) === 'TAG') { offset += 128; break; }
    const a = bytes[offset], b = bytes[offset + 1], c = bytes[offset + 2];
    let size;
    if (adts) {
      if (a !== 255 || (b & 246) !== 240 || (c >> 2 & 15) > 12) reject();
      size = (bytes[offset + 3] & 3) * 2048 + bytes[offset + 4] * 8 + (bytes[offset + 5] >> 5);
      if (size < ((b & 1) ? 7 : 9)) reject();
    } else {
      const version = b >> 3 & 3, bitrate = c >> 4, sample = c >> 2 & 3;
      if (a !== 255 || (b & 224) !== 224 || version === 1 || (b >> 1 & 3) !== 1 || !bitrate || bitrate === 15 || sample === 3) reject();
      const kbps = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrate];
      const hz = [44100,48000,32000][sample] / (version === 3 ? 1 : version === 2 ? 2 : 4);
      size = Math.floor((version === 3 ? 144000 : 72000) * kbps / hz) + (c >> 1 & 1);
    }
    if (!size || offset + size > bytes.length) reject();
    offset += size; count++;
  }
  if (count >= 2 && offset === bytes.length) return adts ? accept('audio/aac', 'aac', ['audio/aacp']) : accept('audio/mpeg', 'mp3', ['audio/mp3']);
  return reject();
}

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
