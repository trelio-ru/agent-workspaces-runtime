import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectEncryptedProposalFilesFromManifest } from "../host-runtime/scripts/trelio-local-context.mjs";
import { ensurePrivateDirectory, writePrivateJsonFile } from "../host-runtime/scripts/trelio-workspace.mjs";
import { withMirrorRetentionLock } from "../host-runtime/scripts/trelio-mirror-retention.mjs";
import { buildRuntimeSessionProof } from "../host-runtime/scripts/trelio-runtime-session.mjs";
import { buildLocalProposalRenderResult } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { LOCAL_PROPOSAL_FILES, localProposalFileProofPayload, selectNativeProposalFiles,
  prepareLocalProposalFiles, pruneLocalProposalFilePreviews } from "../host-runtime/scripts/trelio-proposal-local-files.mjs";

const runId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const origin = "https://trelio.test";
const now = Date.now();
const bytes = Buffer.from("# Проверенный результат\n");
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(t, encrypted = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-preview-test-"));
  t.after(async () => {
    // The snapshots deliberately deny ordinary editor writes. Restore only
    // fixture-owned modes before removing the synthetic tree on every OS.
    async function unlock(p) { for (const e of await fs.readdir(p, { withFileTypes: true })) {
      const child = path.join(p, e.name); if (e.isSymbolicLink()) continue;
      await fs.chmod(child, e.isDirectory() ? 0o700 : 0o600);
      if (e.isDirectory()) await unlock(child);
    } }
    await unlock(directory); await fs.rm(directory, { recursive: true, force: true });
  });
  await ensurePrivateDirectory(directory);
  const root = path.join(directory, "run");
  const workspaceDirectory = path.join(root, "workspace");
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(workspaceDirectory);
  await writePrivateJsonFile(path.join(root, ".trelio-run.json"), { origin, runId, workspaceId,
    workspaceDirectory, company: { slug: "demo" }, encryption: { enabled: encrypted } });
  const source = path.join(workspaceDirectory, "result.md");
  await fs.writeFile(source, bytes, { mode: 0o600 });
  const options = { readRegistry: async () => [root], configDirectory: path.join(directory, "config"), now };
  const files = [{ sourceRunId: runId, filePath: "result.md" }];
  return { directory, root, workspaceDirectory, source, options, files };
}

test("native selection covers single, mixed bundles and completion decisions", () => {
  const single = { runId, filePaths: ["result.md"] };
  assert.equal(selectNativeProposalFiles("propose_task_comment", single).length, 1);
  assert.equal(selectNativeProposalFiles("render_task_proposals", { blocks: [{ type: "text", markdown: "hi" }, single] }).length, 1);
  assert.deepEqual(selectNativeProposalFiles("render_task_proposals", { companySlug: "demo", completions: [{
    decisions: { comment: { filePaths: ["result.md"] } },
  }] }), [{ companySlug: "demo", filePath: "result.md" }]);
  assert.deepEqual(selectNativeProposalFiles("get_task", single), []);
});

test("private snapshot preserves exact bytes after the editable source changes", async (t) => {
  const f = await fixture(t);
  const [preview] = await prepareLocalProposalFiles({ origin, files: f.files }, f.options);
  assert.ok(preview);
  assert.equal(preview.sha256, sha256);
  assert.equal(preview.sizeBytes, bytes.length);
  assert.notEqual(preview.localPath, f.source);
  await fs.writeFile(f.source, "Changed after review");
  assert.deepEqual(await fs.readFile(preview.localPath), bytes);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(preview.localPath)).mode & 0o777, 0o400);
    assert.equal((await fs.stat(path.dirname(preview.localPath))).mode & 0o777, 0o500);
  }
  await pruneLocalProposalFilePreviews(path.dirname(path.dirname(preview.localPath)), now + 30 * 86400000);
  assert.deepEqual(await fs.readFile(preview.localPath), bytes);
  await pruneLocalProposalFilePreviews(path.dirname(path.dirname(preview.localPath)), now + 32 * 86400000);
  await assert.rejects(fs.stat(preview.localPath), { code: "ENOENT" });
});

test("missing files, traversal, ambiguous roots and symlinks retain download", async (t) => {
  const f = await fixture(t);
  for (const filePath of ["missing.md", "../result.md", "/result.md", "a/../../result.md", "AGENTS.md", ".git/config"])
    assert.deepEqual(await prepareLocalProposalFiles({ origin, files: [{ sourceRunId: runId, filePath }] }, f.options), []);
  assert.deepEqual(await prepareLocalProposalFiles({ origin, files: f.files },
    { ...f.options, readRegistry: async () => [f.root, f.root] }), []);
  await fs.unlink(f.source);
  try {
    await fs.symlink(path.join(f.root, ".trelio-run.json"), f.source);
    assert.deepEqual(await prepareLocalProposalFiles({ origin, files: f.files }, f.options), []);
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    t.diagnostic("Windows account lacks symlink creation privilege; POSIX covers symlink rejection");
  }
  // A registry must never turn an arbitrary existing file outside a Run into
  // a preview merely because a caller supplied a plausible filename.
  assert.deepEqual(await prepareLocalProposalFiles({ origin: "https://other.test", files: f.files }, f.options), []);
});

test("encrypted files require the authenticated plaintext manifest digest and stay local", async (t) => {
  const f = await fixture(t, true);
  assert.deepEqual(await prepareLocalProposalFiles({ origin, files: f.files }, f.options), []);
  assert.deepEqual(await prepareLocalProposalFiles({ origin, allowEncrypted: true, files: f.files }, f.options), []);
  const selected = { ...f.files[0], workspaceId, sha256, sizeBytes: bytes.length };
  assert.equal((await prepareLocalProposalFiles({ origin, allowEncrypted: true, files: [selected] }, f.options)).length, 1);
  assert.deepEqual(await prepareLocalProposalFiles({ origin, allowEncrypted: true, files: [{ ...selected, sha256: "a".repeat(64) }] }, f.options), []);
});

test("preview signature is independent of the compatible one-use admission proof", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const files = [{ sourceRunId: runId, workspaceId, filePath: "result.md", sha256, sizeBytes: bytes.length,
    localPath: "/private/snapshot/result.md", expiresAt: new Date(now + 86400000).toISOString() }];
  const proof = buildRuntimeSessionProof({ state: { runtimeSessionId: runId,
    privateKeyPkcs8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url") },
    toolName: "propose_task_comment", localFiles: files, localFilePayload: localProposalFileProofPayload });
  const original = Buffer.from(["trelio-runtime-proof-v1", proof.runtimeSessionId, "propose_task_comment", proof.issuedAt, proof.nonce].join("\n"));
  assert.equal(crypto.verify(null, original, publicKey, Buffer.from(proof.signature, "base64url")), true);
  assert.equal(crypto.verify(null, localProposalFileProofPayload(proof, "propose_task_comment", files), publicKey,
    Buffer.from(proof.localFilePreviews.signature, "base64url")), true);
  assert.equal(crypto.verify(null, localProposalFileProofPayload(proof, "render_task_comment_proposal", files), publicKey,
    Buffer.from(proof.localFilePreviews.signature, "base64url")), false);
});

test("local proposal paths appear only in hidden App metadata, never model receipts", async () => {
  const proposal = { schemaVersion: 4, currentDraft: { proposalId: runId, revision: 1, bodyText: "Done", attachments: [] } };
  const previews = [{ proposalId: runId, attachmentId: workspaceId, sha256, localPath: "/private/snapshot/result.md",
    expiresAt: new Date(now + 86400000).toISOString() }];
  Object.defineProperty(proposal, LOCAL_PROPOSAL_FILES, { value: previews });
  const result = await buildLocalProposalRenderResult({ result: { proposal }, companySlug: "demo", kind: "comment", operation: "save" });
  assert.deepEqual(result._meta["trelio/taskProposalLocalFiles"], previews);
  assert.doesNotMatch(JSON.stringify(result.structuredContent) + JSON.stringify(result.content), /private\/snapshot/);
});


test("full preview cache retains existing snapshots and leaves new files downloadable", async (t) => {
  const f = await fixture(t);
  const cache = path.join(f.options.configDirectory, "proposal-file-previews");
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const existing = path.join(cache, `${now}-${crypto.randomUUID()}`);
  await fs.mkdir(existing, { mode: 0o700 });
  const large = path.join(existing, "existing.bin");
  const handle = await fs.open(large, "wx", 0o600);
  await handle.truncate(512 * 1024 * 1024); await handle.close();
  assert.deepEqual(await prepareLocalProposalFiles({ origin, files: f.files }, f.options), []);
  assert.equal((await fs.stat(large)).size, 512 * 1024 * 1024);
});


test("accepted E2EE manifest digest remains non-enumerable and never enters save JSON", () => {
  const projectionId = crypto.randomUUID(), sourceFileId = crypto.randomUUID(), acceptedHead = "c".repeat(40);
  const manifest = { schemaVersion: 1, kind: "agent-workspace-browser-manifest", projectionId, workspaceId,
    workspaceHead: acceptedHead, files: [{ id: sourceFileId, path: "result.md", contentType: "text/markdown",
      sizeBytes: bytes.length, plaintextSha256: sha256 }] };
  const [selected] = selectEncryptedProposalFilesFromManifest({ manifest, projectionId, workspaceId,
    acceptedHead, projectionFileCount: 1, filePaths: ["result.md"] });
  assert.equal(selected[LOCAL_PROPOSAL_FILES].sha256, sha256);
  assert.doesNotMatch(JSON.stringify(selected), new RegExp(sha256));
  delete manifest.files[0].plaintextSha256;
  const [legacy] = selectEncryptedProposalFilesFromManifest({ manifest, projectionId, workspaceId,
    acceptedHead, projectionFileCount: 1, filePaths: ["result.md"] });
  assert.equal(legacy[LOCAL_PROPOSAL_FILES], undefined);
});


test("a concurrent cache owner leaves preview optional without waiting or changing live files", async (t) => {
  const f = await fixture(t);
  const [original] = await prepareLocalProposalFiles({ origin, files: f.files }, f.options);
  const cacheRoot = path.dirname(path.dirname(original.localPath));
  await withMirrorRetentionLock(cacheRoot, async () => {
    assert.deepEqual(await prepareLocalProposalFiles({ origin, files: f.files }, f.options), []);
    assert.deepEqual(await fs.readFile(original.localPath), bytes);
  });
});
