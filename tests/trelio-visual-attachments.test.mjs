import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { visualAttachmentFormat, visualAudioFormat, MAX_ATTACHMENT_BYTES } from '../host-runtime/scripts/trelio-visual-browser.mjs';
import { saveVisualAttachment, freezeVisualUploads } from '../host-runtime/scripts/trelio-visual-extension-browser.mjs';
import { validateVisualResult, parseVisualSkillOutput, visualMcpResult } from '../host-runtime/scripts/trelio-visual-result.mjs';
import { validVisualArguments, visualStatus } from '../host-runtime/scripts/trelio-visual-result.mjs';

test('audio refusal diagnostics survive MCP with closed evidence only and never authorize a receipt', () => {
  const diagnostics = [
    { stage: 'audio_response', code: 'unsupported_status', httpStatus: 206 },
    { stage: 'audio_response', code: 'invalid_headers' },
    { stage: 'audio_blob', code: 'unsupported_mime', format: 'webm' },
    { stage: 'audio_container', code: 'unsupported_container', format: 'mpeg' },
  ];
  for (const audioDiagnostic of diagnostics) {
    const value = visualStatus('error', 'attachment_unsupported', { audioDiagnostic });
    assert.deepEqual(JSON.parse(visualMcpResult(parseVisualSkillOutput(JSON.stringify(value))).content[0].text).audioDiagnostic, audioDiagnostic);
    for (const patch of [{ url: 'https://example.test/private' }, { message: 'PRIVATE_HEADER_BODY' }, { format: 'PRIVATE_MIME' }, { httpStatus: 999 }]) {
      assert.throws(() => visualStatus('error', 'attachment_unsupported', { audioDiagnostic: { ...audioDiagnostic, ...patch } }), { code: 'VISUAL_RESULT_INVALID' });
    }
    assert.throws(() => visualStatus('ready', 'none', { audioDiagnostic }), { code: 'VISUAL_RESULT_INVALID' });
    assert.throws(() => visualStatus('error', 'operation_failed', { audioDiagnostic }), { code: 'VISUAL_RESULT_INVALID' });
  }
  let refusal;
  try { visualAudioFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]), 'application/octet-stream'); } catch (error) { refusal = error; }
  assert.equal(refusal.code, 'attachment_unsupported');
  assert.deepEqual(refusal.audioDiagnostic, { stage: 'audio_container', code: 'unsupported_container', format: 'ebml' });
});

test('audio originals require complete containers/frames and a matching MIME, independently of document downloads', async () => {
  const wav = Buffer.alloc(204);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const ogg = Buffer.alloc(47); ogg.write('OggS'); ogg[26] = 1; ogg[27] = 19; ogg.write('OpusHead', 28);
  const mp3 = Buffer.alloc(417 * 2); for (const offset of [0, 417]) mp3.set([255, 251, 144, 0], offset);
  const aac = Buffer.from([255,241,80,128,1,63,252,0,0, 255,241,80,128,1,63,252,0,0]);
  const flac = Buffer.alloc(43); flac.write('fLaC'); flac[4] = 128; flac[7] = 34;
  const box = (type, data) => { const value = Buffer.alloc(data.length + 8); value.writeUInt32BE(value.length); value.write(type, 4); data.copy(value, 8); return value; };
  const handler = Buffer.alloc(12); handler.write('soun', 8);
  const m4a = Buffer.concat([box('ftyp', Buffer.from('M4A \0\0\0\0')), box('moov', box('trak', box('mdia', box('hdlr', handler)))), box('mdat', Buffer.from([1]))]);
  for (const [bytes, mime, extension] of [[wav,'audio/x-wav','wav'],[ogg,'audio/opus','opus'],[mp3,'audio/mpeg','mp3'],[aac,'audio/aac','aac'],[flac,'audio/flac','flac'],[m4a,'audio/mp4','m4a']]) {
    assert.equal(visualAudioFormat(bytes, mime).extension, extension);
    assert.equal(visualAudioFormat(bytes, 'application/octet-stream').extension, extension);
    assert.throws(() => visualAudioFormat(bytes, 'text/html'), { code: 'attachment_unsupported' });
    assert.throws(() => visualAttachmentFormat(bytes, mime), { code: 'attachment_unsupported' });
    assert.throws(() => visualAudioFormat(bytes.subarray(0, -1), mime), { code: 'attachment_unsupported' });
  }
  for (const bytes of [Buffer.from('<html>not audio</html>'), Buffer.from('{"url":"private"}'), Buffer.from('OggS'), Buffer.from('ID3'), Buffer.from('RIFF\0\0\0\0WAVE')]) assert.throws(() => visualAudioFormat(bytes, 'audio/mpeg'), { code: 'attachment_unsupported' });
  assert.throws(() => visualAudioFormat(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), 'audio/wav'), { code: 'attachment_too_large' });
  const video = Buffer.from(m4a); video.write('vide', video.indexOf('soun'));
  assert.throws(() => visualAudioFormat(video, 'audio/mp4'), { code: 'attachment_unsupported' });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-audio-receipt-')));
  try {
    const file = { mimeType: 'audio/wav', dataBase64: wav.toString('base64') }, sessionId = randomUUID();
    await assert.rejects(saveVisualAttachment(directory, file, sessionId), { code: 'attachment_unsupported' });
    const receipt = await saveVisualAttachment(directory, file, sessionId, { audioOnly: true });
    assert.deepEqual(await fs.readFile(receipt.filePath), wav);
    assert.equal(receipt.mimeType, 'audio/wav'); assert.equal(path.extname(receipt.filePath), '.wav');
    assert.equal(Object.keys(receipt).sort().join(), 'expiresAt,filePath,kind,mimeType,reason,sessionId,sha256,sizeBytes,state');
    await saveVisualAttachment(directory, { mimeType: 'audio/opus', dataBase64: ogg.toString('base64') }, sessionId, { audioOnly: true });
    assert.deepEqual(await fs.readFile(receipt.filePath), wav, 'a later audio receipt never evicts a fresh original');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// A tiny stored ZIP builder keeps the fixture public, deterministic and free
// of Office tooling, downloaded documents and corporate source/code samples.
function zip(names) {
  const local = [], central = []; let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name), body = Buffer.from('synthetic data');
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt32LE(crc32(body), 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(body.length, 22); head.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc32(body), 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(body.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(head, filename, body); central.push(entry, filename); offset += head.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('file validation recognizes documents from bytes and never treats a filename/MIME as proof', () => {
  const pdf = Buffer.from('%PDF-1.7\nSYNTHETIC_ORIGINAL\n%%EOF\n');
  assert.equal(visualAttachmentFormat(pdf, 'application/octet-stream').extension, 'pdf');
  assert.equal(visualAttachmentFormat(Buffer.from('Заметка\n'), 'text/plain').extension, 'txt');
  assert.equal(visualAttachmentFormat(Buffer.from('a,b\n1,2\n'), 'text/csv').extension, 'csv');
  assert.equal(visualAttachmentFormat(Buffer.from('{\\rtf1 synthetic}'), 'application/rtf').extension, 'rtf');
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  assert.equal(visualAttachmentFormat(zip(['[Content_Types].xml', 'word/document.xml']), docx).extension, 'docx');
  assert.equal(visualAttachmentFormat(zip(['data.csv']), 'application/zip').extension, 'zip');
  for (const [bytes, mime] of [[Buffer.from('<!doctype html>source'), 'text/plain'], [pdf, 'text/html'], [Buffer.from('MZ SYNTHETIC_EXECUTABLE'), 'application/pdf'], [zip(['../escape']), 'application/zip'], [zip(['same', 'same']), 'application/zip'], [zip(['data.csv']), docx], [Buffer.from([0, 1, 2]), 'text/plain'], [Buffer.from('<svg/>'), 'image/svg+xml']]) assert.throws(() => visualAttachmentFormat(bytes, mime), { code: 'attachment_unsupported' });
  assert.throws(() => visualAttachmentFormat(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), 'application/pdf'), { code: 'attachment_too_large' });
});

test('private delivery retains original bytes and MCP projects only a bounded local receipt', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-attachment-receipt-'))), sessionId = randomUUID();
  const bytes = Buffer.from('%PDF-1.7\nSYNTHETIC_PRIVATE_FILE_CONTENT\n%%EOF\n');
  try {
    const receipt = await saveVisualAttachment(directory, { mimeType: 'application/pdf', dataBase64: bytes.toString('base64') }, sessionId);
    assert.deepEqual(await fs.readFile(receipt.filePath), bytes); assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(path.basename(receipt.filePath).endsWith('.pdf'), true);
    const result = visualMcpResult(parseVisualSkillOutput(JSON.stringify(receipt)));
    assert.equal(result.content.length, 1); assert.equal(result.content[0].type, 'text');
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|dataBase64|Content-Type|http:/);
    assert.ok(receipt.expiresAt > Date.now() + 23 * 60 * 60 * 1000);
    for (const extra of [{ body: 'forbidden' }, { headers: {} }, { url: 'https://example.test/file' }, { image: {} }, { filePath: '../unsafe' }]) assert.throws(() => validateVisualResult({ ...receipt, ...extra }), { code: 'VISUAL_RESULT_INVALID' });
    const previous = path.join(directory, 'attachments', `${randomUUID()}.txt`); await fs.writeFile(previous, 'old', { mode: 0o600 }); await fs.utimes(previous, 0, 0);
    await saveVisualAttachment(directory, { mimeType: 'application/pdf', dataBase64: bytes.toString('base64') }, sessionId);
    assert.equal(await fs.stat(previous).then(() => true, error => error.code !== 'ENOENT'), false, 'only expired own-cache originals are removed');
    const unexpected = path.join(directory, 'attachments', 'unknown.txt'); await fs.writeFile(unexpected, 'keep', { mode: 0o600 });
    await assert.rejects(saveVisualAttachment(directory, { mimeType: 'application/pdf', dataBase64: bytes.toString('base64') }, sessionId), { code: 'storage_unavailable' }); assert.equal(await fs.readFile(unexpected, 'utf8'), 'keep');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('attachment delivery refuses a symlink-backed destination before writing', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-attachment-link-')));
  try {
    const other = path.join(directory, 'other'); await fs.mkdir(other, { mode: 0o700 }); await fs.symlink(other, path.join(directory, 'attachments'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(saveVisualAttachment(directory, { mimeType: 'text/plain', dataBase64: Buffer.from('synthetic').toString('base64') }, randomUUID()));
    assert.deepEqual(await fs.readdir(other), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('maximum-size original uses canonical decoding and a full cache never evicts fresh files', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-attachment-bounds-')));
  try {
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x20); bytes.write('%PDF-1.7\n'); bytes.write('%%EOF\n',bytes.length-6);
    const sessionId = randomUUID(), input = {mimeType:'application/pdf',dataBase64:bytes.toString('base64')};
    const receipt = await saveVisualAttachment(directory,input,sessionId); assert.equal(receipt.sizeBytes,MAX_ATTACHMENT_BYTES);
    assert.equal((await fs.stat(receipt.filePath)).size,MAX_ATTACHMENT_BYTES);
    await assert.rejects(saveVisualAttachment(directory,{...input,dataBase64:input.dataBase64+'\n'},sessionId),{code:'attachment_unsupported'});
    for (let i=1;i<32;i++) await fs.writeFile(path.join(directory,'attachments',`${randomUUID()}.txt`),'synthetic',{mode:0o600});
    await assert.rejects(saveVisualAttachment(directory,{mimeType:'text/plain',dataBase64:Buffer.from('extra').toString('base64')},sessionId),{code:'attachment_limit_reached'});
    assert.equal((await fs.readdir(path.join(directory,'attachments'))).length,32); assert.equal((await fs.stat(receipt.filePath)).size,MAX_ATTACHMENT_BYTES);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('outgoing staging preserves arbitrary formats, original names, empty files and bytes above the incoming limit', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-upload-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owned = path.join(directory, 'owned'); await fs.mkdir(owned, { mode: 0o700 });
  const entries = [
    ['документ.docx', Buffer.from('synthetic document bytes')],
    ['archive.zip', Buffer.from('opaque original archive, never extracted')],
    ['script.js', Buffer.from('untrusted file bytes, never executed')],
    ['unknown.data', Buffer.alloc(21 * 1024 * 1024, 0x78)],
    ['empty.txt', Buffer.alloc(0)],
  ];
  const files = [];
  for (const [name, bytes] of entries) { const file = path.join(directory, name); await fs.writeFile(file, bytes); files.push(file); }
  const modes = await Promise.all(files.map(async file => (await fs.stat(file)).mode));
  const frozen = await freezeVisualUploads({ directory: owned, files, deadlineAt: Date.now() + 30_000 });
  assert.equal(frozen.files.length, entries.length);
  for (const [index, result] of frozen.files.entries()) {
    assert.equal(path.basename(result.filePath), entries[index][0]);
    assert.notEqual(result.filePath, files[index]);
    assert.deepEqual(await fs.readFile(result.filePath), entries[index][1]);
    assert.equal(result.sha256, createHash('sha256').update(entries[index][1]).digest('hex'));
    assert.equal((await fs.stat(files[index])).mode, modes[index], 'never harden or rewrite a selected source');
  }
  await fs.writeFile(files[0], 'changed after selection');
  assert.deepEqual(await fs.readFile(frozen.files[0].filePath), entries[0][1], 'browser receives frozen bytes');
  assert.equal(validVisualArguments('upload-files', { frameId: randomUUID(), x: 1, y: 2, files }), true);
  for (const input of [[], ['relative'], [files[0], files[0]], null]) {
    assert.equal(validVisualArguments('upload-files', { frameId: randomUUID(), x: 1, y: 2, files: input }), false);
  }
});

test('outgoing staging refuses directories, hardlinks, linked ancestors, resource overflow and expired work before browser input', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-upload-guards-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owned = path.join(directory, 'owned'); await fs.mkdir(owned, { mode: 0o700 });
  const file = path.join(directory, 'source.bin'); await fs.writeFile(file, 'synthetic bytes');
  const stage = (files, extra = {}) => freezeVisualUploads({ directory: owned, files, deadlineAt: Date.now() + 30_000, ...extra });
  await assert.rejects(stage([directory]), { code: 'upload_file_invalid' });
  await assert.rejects(stage([file], { remainingBytes: 1 }), { code: 'upload_limit_reached' });
  await assert.rejects(stage([file], { deadlineAt: 0 }), { code: 'lease_expired' });
  const alias = path.join(directory, 'linked');
  await fs.symlink(owned, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedSource = path.join(owned, 'linked-source.bin'); await fs.writeFile(linkedSource, 'keep');
  await assert.rejects(stage([path.join(alias, 'linked-source.bin')]), { code: 'upload_file_invalid' });
  const hardlink = path.join(directory, 'hardlink.bin'); await fs.link(file, hardlink);
  await assert.rejects(stage([hardlink]), { code: 'upload_file_invalid' });
  assert.deepEqual((await fs.readdir(owned)).sort(), ['linked-source.bin']);
  assert.equal(await fs.readFile(file, 'utf8'), 'synthetic bytes');
});

test('a source changed during streaming is never handed to the browser and its partial copy is removed', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-upload-race-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owned = path.join(directory, 'owned'); await fs.mkdir(owned, { mode: 0o700 });
  const file = path.join(directory, 'source.bin'); await fs.writeFile(file, Buffer.alloc(128 * 1024, 1));
  const open = fs.open;
  let changed = false;
  fs.open = async function(target, ...args) {
    const handle = await open.call(this, target, ...args);
    if (target === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed) { changed = true; await fs.appendFile(file, 'replacement bytes'); }
        return result;
      };
    }
    return handle;
  };
  try {
    await assert.rejects(freezeVisualUploads({ directory: owned, files: [file], deadlineAt: Date.now() + 30_000 }), { code: 'upload_file_changed' });
    assert.equal(changed, true);
    assert.deepEqual(await fs.readdir(owned), []);
  } finally { fs.open = open; }
});
