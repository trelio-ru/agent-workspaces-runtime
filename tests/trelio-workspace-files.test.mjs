import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentEncryptionDevice, encryptFileToCompanyContainer } from "../host-runtime/scripts/trelio-company-encryption.mjs";
import { readEncryptedWorkspaceFileManifest, readEncryptedWorkspaceSearchChunks, readEncryptedWorkspaceSelectedFile, validateWorkspaceFileLocator } from "../host-runtime/scripts/trelio-workspace-files.mjs";
import { matchWorkspaceTextChunks } from "../host-runtime/scripts/trelio-workspace-text-chunks.mjs";
import { createEncryptedSearchFileCache } from "../host-runtime/scripts/trelio-local-context.mjs";
import { readEncryptedWorkspaceSearchDocuments, resolveWorkspaceBridgeConfigDirectory } from "../host-runtime/scripts/trelio-workspace.mjs";

test("encrypted discovery reads names and bounded text; delivery decrypts only the selected original", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trelio-file-delivery-test-"));
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const scopeId = "33333333-3333-4333-8333-333333333333";
  const projectionId = "44444444-4444-4444-8444-444444444444";
  const manifestId = "55555555-5555-4555-8555-555555555555";
  const imageId = "66666666-6666-4666-8666-666666666666";
  const textId = "77777777-7777-4777-8777-777777777777";
  const deviceId = "88888888-8888-4888-8888-888888888888";
  const secondTextId = "99999999-9999-4999-8999-999999999999";
  const largeTextId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const invalidTextId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const head = "a".repeat(40);
  const scope = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const device = await createAgentEncryptionDevice();
  const publicJwk = await webcrypto.subtle.exportKey("jwk", scope.publicKey);
  const companyEncryption = { runtime: { company: { id: companyId }, scope: { id: scopeId, epoch: 1, publicEncryptionJwk: publicJwk }, device: { id: deviceId } },
    scopePrivateEncryptionKey: { privateKey: scope.privateKey, privateJwk: await webcrypto.subtle.exportKey("jwk", scope.privateKey) } };
  const original = Buffer.from([255, 216, 0, 1, 2, 255, 217]);
  const text = Buffer.from("Документы Марии", "utf8");
  // Larger than both the old index budget and the independent 24 MiB download
  // budget: indexing must stream authenticated chunks without using delivery.
  const largeText = Buffer.from("начало " + "x ".repeat(13 * 1024 * 1024) + " договор согласован");
  const invalidText = Buffer.concat([Buffer.from([0xff]), Buffer.alloc(2 * 1024 * 1024)]);
  const files = [
    { id: imageId, path: "sources/original.jpg", sizeBytes: original.length, contentType: "image/jpeg" },
    { id: textId, path: "description.md", sizeBytes: text.length, contentType: "text/plain; charset=utf-8" },
  ];
  files.push({ id: secondTextId, path: "second.md", sizeBytes: text.length, contentType: "text/plain" });
  files.push({ id: largeTextId, path: "large.md", sizeBytes: largeText.length, contentType: "text/plain" });
  files.push({ id: invalidTextId, path: "invalid.md", sizeBytes: invalidText.length, contentType: "text/plain" });
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "agent-workspace-browser-manifest", projectionId,
    workspaceId, workspaceHead: head, files }));
  const ciphertexts = new Map();
  for (const [id, bytes, kind] of [[manifestId, manifest, "manifest"], [imageId, original, "file"], [textId, text, "file"], [secondTextId, text, "file"], [largeTextId, largeText, "file"], [invalidTextId, invalidText, "file"]]) {
    const sourcePath = path.join(root, `${id}.source`);
    const destinationPath = path.join(root, `${id}.trelioe1`);
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    await encryptFileToCompanyContainer({ sourcePath, destinationPath, scopePublicEncryptionJwk: publicJwk,
      aad: { companyId, scopeId, scopeEpoch: 1, entityType: `agent_workspace_browser_${kind}`, entityId: id, entityRevision: 1 },
      originalName: "fixture", mimeType: "application/octet-stream", writerDeviceId: deviceId,
      signingPrivateKey: device.privateKeys.signingPrivateKey });
    ciphertexts.set(id, await readFile(destinationPath));
  }
  const requests = [];
  let partialConflict = true;
  let stale = false;
  let corrupt = false;
  let denied = false;
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (denied) { response.statusCode = 403; response.end(JSON.stringify({ code: "ACCESS_DENIED" })); return; }
    if (request.url === `/api/agent-workspaces/workspaces/${workspaceId}`) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ company: { id: companyId }, workspace: { acceptedHead: head },
        encryption: { browserProjection: { id: projectionId, workspaceHead: head, manifestFileId: manifestId, fileCount: files.length } } }));
      return;
    }
    const fileId = /\/files\/([^/]+)\/encrypted-content$/u.exec(request.url)?.[1];
    const bytes = ciphertexts.get(fileId);
    if (!bytes) { response.statusCode = 404; response.end(); return; }
    response.setHeader("x-trelio-workspace-id", workspaceId);
    response.setHeader("x-trelio-workspace-head", (stale || (partialConflict && fileId === secondTextId)) ? "b".repeat(40) : head);
    response.setHeader("x-trelio-ciphertext-sha256", createHash("sha256").update(bytes).digest("hex"));
    response.end(corrupt ? Buffer.alloc(bytes.length) : bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const input = { origin: `http://127.0.0.1:${server.address().port}`, token: "synthetic-test-token", companyEncryption,
    workspaceId, workspaceHead: head, acceptedHead: head };
  try {
    const cacheOptions = { paths: { root: path.join(root, "cache") }, origin: input.origin, companyEncryption };
    input.searchCache = await createEncryptedSearchFileCache(cacheOptions);
    await assert.rejects(readEncryptedWorkspaceSearchDocuments(input), { code: "WORKSPACE_OUTDATED" });
    assert.equal(requests.filter((url) => url.includes(textId)).length, 1);
    // New cache object represents the next process/attempt. The first file was
    // saved even though its sibling conflicted; the manifest is still fetched.
    input.searchCache = await createEncryptedSearchFileCache(cacheOptions);
    partialConflict = false;
    const documents = await readEncryptedWorkspaceSearchDocuments(input);
    assert.equal(requests.filter((url) => url.includes(textId)).length, 1);
    assert.equal(requests.filter((url) => url.includes(secondTextId)).length, 2);
    assert.equal(documents.find((file) => file.name === "original.jpg").text, "");
    assert.equal(documents.find((file) => file.name === "description.md").chunks[0].text, text.toString("utf8"));
    assert.equal(documents.find((file) => file.name === "description.md").searchCoverage.status, "complete");
    const large = documents.find((file) => file.name === "large.md");
    assert.equal(large.searchCoverage.indexedBytes, largeText.length);
    assert.match(matchWorkspaceTextChunks(large.path, large.chunks, "начало договор").previewText, /договор/u);
    assert.equal(documents.find((file) => file.name === "invalid.md").searchCoverage.status, "unsupported");
    assert.equal(documents.find((file) => file.name === "invalid.md").chunks.length, 0);
    assert.equal(requests.some((url) => url.includes(imageId)), false, "indexing a binary name must not download its bytes");
    const selected = (await readEncryptedWorkspaceFileManifest(input)).find((file) => file.id === imageId);
    const stagingRoot = path.join(resolveWorkspaceBridgeConfigDirectory(), "search-staging");
    const stagingBefore = await readdir(stagingRoot);
    const largeFile = files.find((file) => file.id === largeTextId);
    await assert.rejects(readEncryptedWorkspaceSearchChunks({ ...input, signal: AbortSignal.abort() }, largeFile));
    assert.deepEqual(await readdir(stagingRoot), stagingBefore, "Cancellation must remove its ciphertext staging directory");
    for (let repeat = 0; repeat < 2; repeat++) assert.deepEqual(await readEncryptedWorkspaceSelectedFile(input, selected), original);
    assert.equal(requests.some((url) => url.includes("bundle") || url.includes("original.jpg")), false);
    stale = true;
    await assert.rejects(readEncryptedWorkspaceSelectedFile(input, selected), { code: "WORKSPACE_OUTDATED" });
    stale = false; corrupt = true;
    await assert.rejects(readEncryptedWorkspaceSelectedFile(input, selected));
    await assert.rejects(readEncryptedWorkspaceSearchChunks(input, files.find((file) => file.id === textId)));
    assert.deepEqual(await readdir(stagingRoot), stagingBefore, "Crypto failure must leave no partial search staging");
    corrupt = false; denied = true;
    await assert.rejects(readEncryptedWorkspaceFileManifest(input), { code: "ACCESS_DENIED" });
    await assert.rejects(readEncryptedWorkspaceSearchDocuments(input), { code: "ACCESS_DENIED" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("encrypted discovery treats only a server-confirmed initial revision as an empty projection", async () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const head = "a".repeat(40);
  let browserProjectionRequired = false;
  const server = createServer((request, response) => {
    if (request.url !== `/api/agent-workspaces/workspaces/${workspaceId}`) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      company: { id: companyId },
      workspace: { acceptedHead: head },
      encryption: browserProjectionRequired === undefined
        ? {}
        : { browserProjectionRequired },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const input = {
    origin: `http://127.0.0.1:${server.address().port}`,
    token: "synthetic-test-token",
    companyEncryption: { runtime: { company: { id: companyId } } },
    workspaceId,
    workspaceHead: head,
  };

  try {
    assert.deepEqual(await readEncryptedWorkspaceFileManifest(input), []);
    assert.deepEqual(await readEncryptedWorkspaceSearchDocuments({
      ...input,
      acceptedHead: head,
    }), []);

    browserProjectionRequired = true;
    await assert.rejects(
      readEncryptedWorkspaceFileManifest(input),
      { code: "WORKSPACE_BROWSER_PROJECTION_UNAVAILABLE" },
    );

    // An older or malformed server response must not be mistaken for the
    // explicitly authenticated initial-empty state.
    browserProjectionRequired = undefined;
    await assert.rejects(
      readEncryptedWorkspaceFileManifest(input),
      { code: "WORKSPACE_BROWSER_PROJECTION_UNAVAILABLE" },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("file locators reject traversal and foreign path syntax before transport", () => {
  for (const filePath of ["../secret", "/etc/passwd", "x/../secret", "x\\secret", "x//secret", "x\0secret"]) {
    assert.throws(() => validateWorkspaceFileLocator({ workspaceId: "11111111-1111-4111-8111-111111111111", workspaceHead: "a".repeat(40), filePath }), { code: "WORKSPACE_FILE_INVALID_LOCATOR" });
  }
});
