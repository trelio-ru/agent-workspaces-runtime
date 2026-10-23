import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { visualAttachmentFormat, MAX_ATTACHMENT_BYTES } from '../host-runtime/scripts/trelio-visual-browser.mjs';
import { saveVisualAttachment, freezeVisualUploads } from '../host-runtime/scripts/trelio-visual-extension-browser.mjs';
import { validateVisualResult, parseVisualSkillOutput, visualMcpResult } from '../host-runtime/scripts/trelio-visual-result.mjs';
import { validVisualArguments } from '../host-runtime/scripts/trelio-visual-result.mjs';

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
