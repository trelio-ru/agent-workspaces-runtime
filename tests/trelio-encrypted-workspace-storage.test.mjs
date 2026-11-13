import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { createAgentEncryptionDevice, canonicalJson, encryptFileToCompanyContainer } from "../host-runtime/scripts/trelio-company-encryption.mjs";
import {
  ENCRYPTED_WORKSPACE_PART_BYTES, ENCRYPTED_WORKSPACE_MAX_MANIFEST_BYTES,
  ENCRYPTED_WORKSPACE_MAX_CONTAINER_BYTES, ENCRYPTED_WORKSPACE_MAX_CHAIN_LENGTH,
  encryptedWorkspaceCacheKey, materializeEncryptedWorkspaceChain,
  prepareCachedEncryptedWorkspaceFile, uploadEncryptedWorkspaceFile,
  validateEncryptedWorkspaceCapabilities, buildEncryptedWorkspaceProjectionRecord,
} from "../host-runtime/scripts/trelio-encrypted-workspace-storage.mjs";
import {
  assertEncryptedCandidateSafe, ensurePrivateDirectory, readPrivateJsonFile, writePrivateJsonFile,
  uploadIncrementalEncryptedWorkspaceProjection,
  TrelioApiError, withRateLimitRetry, withEncryptedWorkspaceRequestRetry, requestWithRateLimitRetry,
} from "../host-runtime/scripts/trelio-workspace.mjs";

const exec = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const retry = async (operation) => {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); } catch (error) {
      if (!error.transport || attempt >= 3) throw error;
    }
  }
};
const lost = () => Object.assign(new Error("synthetic lost response"), { transport: true });

const fixture = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-incremental-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scope = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const companyEncryption = {
    runtime: { company: { id: randomUUID() }, scope: { id: randomUUID(), epoch: 1,
      publicEncryptionJwk: await webcrypto.subtle.exportKey("jwk", scope.publicKey) }, device: { id: randomUUID() } },
    device: await createAgentEncryptionDevice(),
    scopePrivateEncryptionKey: { privateKey: scope.privateKey, privateJwk: await webcrypto.subtle.exportKey("jwk", scope.privateKey) },
  };
  const workspaceDirectory = path.join(directory, "workspace");
  await fs.mkdir(workspaceDirectory);
  const git = (args) => exec("git", args, { cwd: workspaceDirectory });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Trelio Test"]);
  await git(["config", "user.email", "test@trelio.local"]);
  await git(["commit", "--allow-empty", "-m", "База"]);
  const baseHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const metadata = { workspaceId: randomUUID(), runId: randomUUID(), leaseId: randomUUID(), fencingToken: 1,
    baseHead, workspaceDirectory, objects: [] };
  const storage = { protocolVersion: 2, workspaceId: metadata.workspaceId, baseHead,
    baseRevision: { id: randomUUID(), head: baseHead, chainLength: 1,
      scopeId: companyEncryption.runtime.scope.id, scopeEpoch: 1 }, projection: null,
    limits: { partSizeBytes: ENCRYPTED_WORKSPACE_PART_BYTES, maxManifestBytes: ENCRYPTED_WORKSPACE_MAX_MANIFEST_BYTES,
      maxContainerBytes: ENCRYPTED_WORKSPACE_MAX_CONTAINER_BYTES, maxChainLength: ENCRYPTED_WORKSPACE_MAX_CHAIN_LENGTH,
      maxFileBytes: 64 * 1024 * 1024, maxFiles: 20000 } };
  return { directory, metadata, companyEncryption, git, storage };
};

/** Stateful transport emulates committed writes followed by a lost response. */
const transport = (binding = {}, lossError = lost) => {
  const uploads = new Map();
  const projections = new Map();
  const requests = [];
  const losses = new Set();
  const status = (upload) => ({ uploadId: upload.uploadId, state: upload.state, kind: upload.kind,
    ciphertextSha256: upload.ciphertextSha256, ciphertextSizeBytes: upload.ciphertextSizeBytes,
    partSizeBytes: ENCRYPTED_WORKSPACE_PART_BYTES,
    parts: [...upload.parts].map(([partIndex, bytes]) => ({ partIndex, sizeBytes: bytes.length, sha256: digest(bytes) })) });
  const api = async (pathname, options = {}) => {
    const method = options.method || "GET";
    requests.push({ pathname, method, size: Buffer.isBuffer(options.body) ? options.body.length : 0 });
    const match = /\/uploads(?:\/([0-9a-f-]+))?(?:\/(parts|complete)(?:\/(\d+))?)?$/u.exec(pathname);
    const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const maybeLose = (key) => { if (losses.delete(key)) throw lossError(); };
    if (match) {
      const [, id, action, index] = match;
      if (!id) {
        const body = JSON.parse(options.body);
        if (!uploads.has(body.uploadId)) uploads.set(body.uploadId, { ...body, state: "uploading", parts: new Map() });
        maybeLose("create");
        return json(status(uploads.get(body.uploadId)));
      }
      const upload = uploads.get(id);
      if (!upload) throw Object.assign(new Error("missing upload"), { statusCode: 404 });
      if (!action) return json(status(upload));
      if (action === "parts") {
        const partIndex = Number(index);
        assert.equal(options.body.length <= ENCRYPTED_WORKSPACE_PART_BYTES, true);
        assert.equal(digest(options.body), options.headers["x-trelio-ciphertext-sha256"]);
        const prior = upload.parts.get(partIndex);
        if (prior) assert.deepEqual(prior, options.body);
        upload.parts.set(partIndex, Buffer.from(options.body));
        maybeLose(`part:${index}`);
        return json({ uploadId: id, partIndex, sha256: digest(options.body), sizeBytes: options.body.length });
      }
      upload.bytes = Buffer.concat([...upload.parts].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes));
      assert.equal(upload.bytes.length, upload.ciphertextSizeBytes);
      assert.equal(digest(upload.bytes), upload.ciphertextSha256);
      upload.state = "ready";
      upload.parts.clear();
      maybeLose("complete");
      return json(status(upload));
    }
    if (pathname.includes("/publication?")) {
      const query = new URL(pathname, "https://trelio.test").searchParams;
      const runId = pathname.split("/runs/")[1].split("/")[0];
      const body = [...projections.values()].find((entry) => entry.workspaceHead === query.get("workspaceHead") && entry.runId === runId);
      if (!body) return json(null);
      return json({ record: buildEncryptedWorkspaceProjectionRecord({ ...body, ...binding, runId }), signature: body.signature,
        result: { projectionId: body.projectionId, workspaceHead: body.workspaceHead, fileCount: body.files.length - 1, state: "staging" } });
    }
    if (pathname.endsWith("/projection")) {
      const body = { ...JSON.parse(options.body), runId: pathname.split("/runs/")[1].split("/")[0] };
      if (projections.has(body.projectionId)) assert.deepEqual(projections.get(body.projectionId), body);
      projections.set(body.projectionId, body);
      maybeLose("projection");
      return json({ projectionId: body.projectionId, workspaceHead: body.workspaceHead, fileCount: body.files.length - 1, state: "staging" });
    }
    const content = /\/files\/([0-9a-f-]+)\/encrypted-content$/u.exec(pathname);
    if (content) return new Response(uploads.get(content[1]).bytes);
    throw new Error(`Unexpected ${method} ${pathname}`);
  };
  return { api, uploads, projections, requests, losses };
};

test("resumable ciphertext reconciles create, part and completion response loss and process restart", async (t) => {
  const { directory, metadata, companyEncryption } = await fixture(t);
  const sourcePath = path.join(directory, "binary.dat");
  await fs.writeFile(sourcePath, randomBytes(ENCRYPTED_WORKSPACE_PART_BYTES + 32768));
  const input = { cacheDirectory: path.join(directory, "cache"), cacheKey: encryptedWorkspaceCacheKey({ fixture: 1 }),
    sourcePath, kind: "content", metadata, companyEncryption, originalName: "private-source.dat",
    mimeType: "application/octet-stream", ensurePrivateDirectory, readPrivateJsonFile, writePrivateJsonFile };
  const file = await prepareCachedEncryptedWorkspaceFile(input);
  const server = transport({ companyId: companyEncryption.runtime.company.id, workspaceId: metadata.workspaceId });
  for (const phase of ["create", "part:0", "complete"]) server.losses.add(phase);
  await uploadEncryptedWorkspaceFile({ file, metadata, api: server.api, retry });
  const resumed = await prepareCachedEncryptedWorkspaceFile(input);
  assert.deepEqual(resumed, file, "UUID, ciphertext and signature survive a fresh invocation");
  const before = server.requests.length;
  await uploadEncryptedWorkspaceFile({ file: resumed, metadata, api: server.api, retry });
  assert.deepEqual(server.requests.slice(before).map((item) => item.method), ["GET"]);
  assert.equal(server.requests.filter((item) => item.method === "PUT").length, 2, "lost part response is reconciled without retransmission");
  const handle = await fs.open(file.encryptedPath, "r+");
  await handle.write(Buffer.from([0]), 0, 1, 0); await handle.close();
  await assert.rejects(uploadEncryptedWorkspaceFile({ file, metadata, api: server.api, retry }), /изменилась/u);
});

test("many small files survive 429 before and after writes without retransmitting ready ciphertext", async (t) => {
  const { directory, metadata, companyEncryption, git, storage } = await fixture(t);
  const rateLimited = () => new TrelioApiError(429, "synthetic rate limit", 3000);
  const server = transport({ companyId: companyEncryption.runtime.company.id, workspaceId: metadata.workspaceId }, rateLimited);
  for (let index = 0; index < 50; index++) {
    await fs.writeFile(path.join(metadata.workspaceDirectory, `file-${index}.txt`), `fixture ${index}`);
  }
  await git(["add", "--all"]); await git(["commit", "-m", "Много файлов"]);
  const workspaceHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
  for (const phase of ["create", "part:0", "complete", "projection"]) server.losses.add(phase);
  const pendingFailures = new Set(["create", "part", "complete"]);
  const delays = [];
  let writes = 0, progress = 0, oldBudgetHit = false;
  const options = {
    metadata, metadataPath: path.join(directory, "private", "run.json"), origin: "https://trelio.test", token: "fixture",
    companyEncryption, workspaceHead, storage,
    onProgress: async () => { progress++; },
    retry: (operation) => withEncryptedWorkspaceRequestRetry(operation, {
      waitForRetry: async (ms) => delays.push(ms), report: () => {},
      waitForCooldown: async () => assert.fail("429 must not enter the network cooldown"),
    }),
    transportRequest: async (_origin, _token, pathname, options = {}) => {
      if (options.method === "POST" || options.method === "PUT") {
        const phase = pathname.endsWith("/uploads") ? "create"
          : pathname.includes("/parts/") ? "part" : pathname.endsWith("/complete") ? "complete" : "projection";
        if (pendingFailures.delete(phase)) throw rateLimited();
        // An old server/proxy budget can still reject the 61st mutation.
        // The logical upload must pause and finish within the same invocation.
        if (writes === 60 && !oldBudgetHit) { oldBudgetHit = true; throw rateLimited(); }
        writes++;
      }
      return server.api(pathname, options);
    },
  };
  const result = await uploadIncrementalEncryptedWorkspaceProjection(options);
  assert.equal(server.projections.get(result.projectionId).files.length, 51);
  assert.equal(oldBudgetHit, true);
  assert.equal(progress >= 51, true);
  assert.deepEqual(delays, Array(8).fill(3000));
  assert.equal(server.requests.filter((entry) => entry.method === "PUT").length, 51);
  assert.equal(writes, 51 * 3 + 1, "committed writes are never replayed");
  const before = server.requests.length;
  const resumed = await uploadIncrementalEncryptedWorkspaceProjection(options);
  assert.equal(resumed.projectionId, result.projectionId, "restart reuses the exact signed projection");
  assert.equal(server.requests.slice(before).every((entry) => entry.method === "GET"), true);
});

test("exhausted 429 retries preserve the immutable cache for a later invocation", async (t) => {
  const { directory, metadata, companyEncryption } = await fixture(t);
  const sourcePath = path.join(directory, "source.txt");
  await fs.writeFile(sourcePath, "small encrypted upload");
  const input = { cacheDirectory: path.join(directory, "cache"), cacheKey: encryptedWorkspaceCacheKey({ fixture: "429" }),
    sourcePath, kind: "content", metadata, companyEncryption, originalName: "source.txt", mimeType: "text/plain",
    ensurePrivateDirectory, readPrivateJsonFile, writePrivateJsonFile };
  const file = await prepareCachedEncryptedWorkspaceFile(input);
  const server = transport();
  let rejections = 0;
  await assert.rejects(uploadEncryptedWorkspaceFile({ file, metadata,
    api: (pathname, options) => {
      if (options?.method === "PUT") { rejections++; throw new TrelioApiError(429, "rate limit", 1000); }
      return server.api(pathname, options);
    },
    retry: (operation) => withEncryptedWorkspaceRequestRetry(operation, {
      waitForRetry: async () => {}, report: () => {},
    }),
  }), { statusCode: 429 });
  assert.equal(rejections, 9);
  const resumed = await prepareCachedEncryptedWorkspaceFile(input);
  assert.deepEqual(resumed, file);
  await uploadEncryptedWorkspaceFile({ file: resumed, metadata, api: server.api, retry: withEncryptedWorkspaceRequestRetry });
  assert.equal(server.uploads.get(file.uploadId).state, "ready");
  assert.equal(server.requests.filter((entry) => entry.method === "POST" && entry.pathname.endsWith("/uploads")).length, 1);
});

test("a tree above 100 MiB uploads once and one-file changes reuse the accepted opaque objects", async (t) => {
  const { directory, metadata, companyEncryption, git, storage } = await fixture(t);
  const server = transport({ companyId: companyEncryption.runtime.company.id, workspaceId: metadata.workspaceId });
  await fs.writeFile(path.join(metadata.workspaceDirectory, "one.bin"), randomBytes(52 * 1024 * 1024));
  await fs.writeFile(path.join(metadata.workspaceDirectory, "two.bin"), randomBytes(52 * 1024 * 1024));
  await git(["add", "--all"]);
  await assertEncryptedCandidateSafe({ workspaceDirectory: metadata.workspaceDirectory, baseHead: metadata.baseHead, storageLimits: storage.limits });
  await assert.rejects(assertEncryptedCandidateSafe({ workspaceDirectory: metadata.workspaceDirectory, baseHead: metadata.baseHead }), /лимит полного снимка/u);
  await git(["commit", "-m", "Два больших файла"]);
  let workspaceHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const call = (currentMetadata, currentStorage) => uploadIncrementalEncryptedWorkspaceProjection({ metadata: currentMetadata,
    metadataPath: path.join(directory, "private", "run.json"), origin: "https://trelio.test", token: "fixture",
    companyEncryption, workspaceHead, storage: currentStorage, retry, onProgress: async () => {},
    transportRequest: (_origin, _token, pathname, options) => server.api(pathname, options) });
  server.losses.add("projection");
  const first = await call(metadata, storage);
  const projection = server.projections.get(first.projectionId);
  assert.equal(projection.files.filter((file) => file.kind === "content").length, 2);
  assert.equal(server.requests.filter((item) => item.method === "PUT").reduce((sum, item) => sum + item.size, 0) > 100 * 1024 * 1024, true);
  assert.equal(JSON.stringify(projection).includes("one.bin"), false);
  assert.equal(server.requests.filter((entry) => entry.method === "POST" && entry.pathname.endsWith("/projection")).length, 1);
  const previousHead = workspaceHead;
  await fs.writeFile(path.join(metadata.workspaceDirectory, "one.bin"), "one small changed file");
  await git(["add", "--all"]); await git(["commit", "-m", "Один файл"]);
  workspaceHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const nextMetadata = { ...metadata, baseHead: previousHead, runId: randomUUID(), leaseId: randomUUID() };
  const nextStorage = { ...storage, baseHead: previousHead,
    baseRevision: { ...storage.baseRevision, id: randomUUID(), head: previousHead },
    projection: { ...projection, id: projection.projectionId, formatVersion: 2, fileCount: 2 } };
  const before = server.requests.length;
  const second = await call(nextMetadata, nextStorage);
  const changed = server.projections.get(second.projectionId);
  const oldIds = new Set(projection.files.filter((file) => file.kind === "content").map((file) => file.id));
  assert.equal(changed.files.filter((file) => oldIds.has(file.id)).length, 1);
  assert.equal(server.requests.slice(before).filter((item) => item.method === "PUT").reduce((sum, item) => sum + item.size, 0) < 32768, true);
  const restart = server.requests.length;
  await call(nextMetadata, nextStorage);
  assert.equal(server.requests.slice(restart).some((item) => item.method === "PUT"), false);
  await assert.rejects(assertEncryptedCandidateSafe({ workspaceDirectory: metadata.workspaceDirectory,
    baseHead: previousHead, storageLimits: { ...storage.limits, maxFileBytes: 1024 } }), /лимит компании/u);
});

test("a 917-file candidate verifies its exact tree in batches and reuses all unchanged ciphertext", async (t) => {
  const { directory, metadata, companyEncryption, git, storage } = await fixture(t);
  const server = transport({ companyId: companyEncryption.runtime.company.id, workspaceId: metadata.workspaceId });
  const scope = companyEncryption.runtime.scope;
  const projectionId = randomUUID();
  const manifestFileId = randomUUID();
  const files = [];
  await git(["config", "core.autocrlf", "true"]);
  for (let index = 0; index < 917; index++) {
    const filePath = `школьный архив ${index}.md`;
    const bytes = Buffer.from(`synthetic source ${index}\r\n`);
    await fs.writeFile(path.join(metadata.workspaceDirectory, filePath), bytes);
    files.push({ id: randomUUID(), path: filePath, sizeBytes: bytes.length,
      plaintextSha256: digest(bytes), contentType: "text/plain; charset=utf-8" });
  }
  await git(["add", "--all"]);
  await git(["commit", "-m", "Принятый архив"]);
  const baseHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const manifest = path.join(directory, "base.json");
  const encryptedManifest = path.join(directory, "base.trelioe1");
  await fs.writeFile(manifest, canonicalJson({ schemaVersion: 1, kind: "agent-workspace-browser-manifest",
    projectionId, workspaceId: metadata.workspaceId, workspaceHead: baseHead, files }));
  const sealed = await encryptFileToCompanyContainer({
    sourcePath: manifest, destinationPath: encryptedManifest, scopePublicEncryptionJwk: scope.publicEncryptionJwk,
    aad: { companyId: companyEncryption.runtime.company.id, scopeId: scope.id, scopeEpoch: scope.epoch,
      entityType: "agent_workspace_browser_manifest", entityId: manifestFileId, entityRevision: 1 },
    writerDeviceId: companyEncryption.runtime.device.id, signingPrivateKey: companyEncryption.device.privateKeys.signingPrivateKey,
  });
  server.uploads.set(manifestFileId, { bytes: await fs.readFile(encryptedManifest) });
  const acceptedProjection = { id: projectionId, formatVersion: 2, workspaceHead: baseHead, scopeId: scope.id,
    scopeEpoch: scope.epoch, manifestFileId, fileCount: files.length,
    files: [{ id: manifestFileId, kind: "manifest", sizeBytes: sealed.ciphertextSizeBytes,
      ciphertextSha256: sealed.ciphertextSha256 }, ...files.map(({ id }) => ({
      id, kind: "content", sizeBytes: 1024, ciphertextSha256: "a".repeat(64),
    }))] };
  await fs.writeFile(path.join(metadata.workspaceDirectory, "новый файл.md"), "new candidate bytes\r\n");
  await git(["add", "--all"]);
  await git(["commit", "-m", "Один новый файл"]);
  const workspaceHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const progress = [];
  const options = {
    metadata: { ...metadata, baseHead }, metadataPath: path.join(directory, "private", "run.json"),
    origin: "https://trelio.test", token: "fixture", companyEncryption, workspaceHead,
    storage: { ...storage, baseHead, baseRevision: { ...storage.baseRevision, head: baseHead },
      projection: acceptedProjection }, retry,
    transportRequest: (_origin, _token, pathname, options) => server.api(pathname, options),
    onProgress: async (value) => progress.push(value.completedFiles),
  };
  const tracePath = path.join(directory, "git-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  let result;
  try {
    result = await uploadIncrementalEncryptedWorkspaceProjection(options);
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }
  const commands = (await fs.readFile(tracePath, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    .filter(event => event.event === "cmd_name").map(event => event.name);
  assert.ok(commands.filter(name => name === "hash-object").length <= 31,
    "two passes per 64-file batch plus one changed file, regardless of platform spawn speed");
  assert.equal(commands.filter(name => name === "ls-tree").length, 1);
  // First use may run the common Git readiness probe once.
  assert.ok(commands.filter(name => name === "rev-parse").length <= 1);
  const saved = server.projections.get(result.projectionId);
  const retained = new Set(saved.files.filter(file => file.kind === "content").map(file => file.id));
  assert.equal(retained.size, files.length + 1);
  assert.ok(files.every(file => retained.has(file.id)));
  assert.equal(server.requests.filter(entry => entry.method === "PUT").length, 2, "only new content and manifest");
  assert.ok(progress.includes(64) && progress.includes(files.length + 1), "unchanged batches advance the lease check");
  const writes = server.requests.filter(entry => ["POST", "PUT"].includes(entry.method)).length;
  await fs.writeFile(path.join(metadata.workspaceDirectory, files[0].path), "stale materialized bytes\r\n");
  await assert.rejects(uploadIncrementalEncryptedWorkspaceProjection({ ...options,
    metadata: { ...options.metadata, runId: randomUUID() } }), /changed after preparing/u);
  assert.equal(server.requests.filter(entry => ["POST", "PUT"].includes(entry.method)).length, writes);
});

test("ciphertext cache refuses bytes that differ from the candidate digest before any upload", async (t) => {
  const { directory, metadata, companyEncryption } = await fixture(t);
  const sourcePath = path.join(directory, "candidate.txt");
  const cacheDirectory = path.join(directory, "cache");
  const original = Buffer.from("expected bytes");
  await fs.writeFile(sourcePath, "modified bytes");
  await assert.rejects(prepareCachedEncryptedWorkspaceFile({
    cacheDirectory, cacheKey: digest(original), sourcePath, kind: "content", metadata, companyEncryption,
    originalName: "candidate.txt", mimeType: "text/plain", expectedSource: {
      sizeBytes: original.length, sha256: digest(original),
    }, ensurePrivateDirectory, readPrivateJsonFile, writePrivateJsonFile,
  }), /bytes changed/u);
  assert.deepEqual(await fs.readdir(cacheDirectory), [], "no stale ciphertext or reusable descriptor");
});

test("capabilities reject a foreign base and never confuse part size with file size", async (t) => {
  const { metadata, storage } = await fixture(t);
  assert.equal(validateEncryptedWorkspaceCapabilities(storage, metadata), storage);
  assert.throws(() => validateEncryptedWorkspaceCapabilities({ ...storage, baseHead: "0".repeat(40) }, metadata), /базовую ревизию/u);
  assert.throws(() => validateEncryptedWorkspaceCapabilities({ ...storage, limits: { ...storage.limits, partSizeBytes: 100 * 1024 * 1024 } }, metadata), /protocol/u);
});

test("encrypted full-base plus delta history restores real Git bytes and rejects damaged parent binding", async (t) => {
  const { directory, metadata, companyEncryption, git } = await fixture(t);
  const revisions = [];
  const frames = [];
  for (let index = 0; index < 2; index++) {
    await fs.writeFile(path.join(metadata.workspaceDirectory, "result.txt"), `revision ${index}`);
    await git(["add", "--all"]); await git(["commit", "-m", `Ревизия ${index}`]);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["update-ref", "refs/heads/trelio-candidate", head]);
    const sourcePath = path.join(directory, `${index}.bundle`);
    await git(["bundle", "create", sourcePath, "refs/heads/trelio-candidate", ...(index ? [`^${revisions[0].workspaceHead}`] : [])]);
    const destinationPath = path.join(directory, `${index}.trelioe1`);
    const encrypted = await encryptFileToCompanyContainer({ sourcePath, destinationPath,
      scopePublicEncryptionJwk: companyEncryption.runtime.scope.publicEncryptionJwk,
      aad: { companyId: companyEncryption.runtime.company.id, scopeId: companyEncryption.runtime.scope.id, scopeEpoch: 1,
        entityType: "agent_workspace_revision", entityId: metadata.runId, entityRevision: 1 },
      originalName: "workspace.bundle", mimeType: "application/vnd.git.bundle",
      writerDeviceId: companyEncryption.runtime.device.id, signingPrivateKey: companyEncryption.device.privateKeys.signingPrivateKey });
    revisions.push({ id: randomUUID(), workspaceHead: head, baseHead: index ? revisions[0].workspaceHead : metadata.baseHead,
      bundleFormat: index ? "delta" : "full", parentRevisionId: index ? revisions[0].id : null,
      scopeId: companyEncryption.runtime.scope.id, scopeEpoch: 1, ciphertextSha256: encrypted.ciphertextSha256,
      ciphertextSizeBytes: encrypted.ciphertextSizeBytes });
    frames.push(await fs.readFile(destinationPath));
  }
  const sourcePath = path.join(directory, "history.trelioh1");
  const saveTransport = async () => {
    const header = Buffer.from(canonicalJson({ schemaVersion: 1, companyId: companyEncryption.runtime.company.id,
      workspaceId: metadata.workspaceId, revisions }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    await fs.writeFile(sourcePath, Buffer.concat([Buffer.from("TRELIOH1"), length, header, ...frames]));
  };
  await saveTransport();
  const destination = path.join(directory, "restored.bundle");
  const options = { sourcePath, destination, companyEncryption, expectedWorkspaceId: metadata.workspaceId,
    expectedWorkspaceHead: revisions[1].workspaceHead, expectedCiphertextSha256: revisions[1].ciphertextSha256,
    ensurePrivateDirectory, runGit: (args) => exec("git", args) };
  await materializeEncryptedWorkspaceChain(options);
  const restored = path.join(directory, "restored");
  await exec("git", ["clone", "-b", "trelio-candidate", destination, restored]);
  assert.equal(await fs.readFile(path.join(restored, "result.txt"), "utf8"), "revision 1");
  // Cancel after a genuine import. The next Git step must not run and the
  // operation cannot publish an incomplete bundle or retain its scratch repo.
  const controller = new AbortController();
  const stop = new Error('test-owned materialization deadline');
  const cancelledBundle = path.join(directory, "cancelled.bundle");
  let scratch, imports = 0;
  await assert.rejects(materializeEncryptedWorkspaceChain({ ...options, destination: cancelledBundle, signal: controller.signal,
    runGit: async (args, { signal }) => {
      assert.equal(signal, controller.signal);
      const result = await exec("git", args);
      if (args[0] === "init") scratch = path.dirname(args.at(-1));
      if (args[3] === "unbundle") { imports++; controller.abort(stop); }
      return result;
    },
  }), error => error === stop);
  assert.equal(imports, 1);
  await assert.rejects(fs.lstat(scratch), { code: "ENOENT" });
  await assert.rejects(fs.lstat(cancelledBundle), { code: "ENOENT" });
  revisions[1].parentRevisionId = randomUUID(); await saveTransport();
  await assert.rejects(materializeEncryptedWorkspaceChain({ ...options, destination: path.join(directory, "invalid.bundle") }), /базовую ревизию/u);
});

test("429 respects Retry-After, uses bounded fallback and stops after eight retries", async () => {
  const delays = [];
  let attempts = 0;
  const error = new TrelioApiError(429, "rate limit");
  await assert.rejects(withRateLimitRetry(async () => {
    attempts++;
    throw error;
  }, { waitForRetry: async (ms) => delays.push(ms), random: () => 0, report: () => {} }), (caught) => caught === error);
  assert.equal(attempts, 9);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  attempts = 0;
  const result = await withRateLimitRetry(async () => {
    if (!attempts++) throw new TrelioApiError(429, "rate limit", 17000);
    return "resumed";
  }, { waitForRetry: async (ms) => assert.equal(ms, 17000), report: () => {} });
  assert.equal(result, "resumed");
  for (const ms of [300001, -1, Infinity, NaN]) {
    await assert.rejects(withRateLimitRetry(async () => { throw new TrelioApiError(429, "rate limit", ms); },
      { waitForRetry: async () => assert.fail("invalid delay must not wait") }), /Retry-After/u);
  }
});

test("eligible HTTP retry stops immediately at transport uncertainty without cooldown or replay", async () => {
  const waits = [];
  let attempts = 0;
  const network = new TypeError("fetch failed");
  await assert.rejects(withEncryptedWorkspaceRequestRetry(async () => {
    attempts++;
    if (attempts === 1) throw new TrelioApiError(429, "rate limit", 2000);
    throw network;
  }, {
    random: () => 0, report: () => {},
    waitForRetry: async (ms) => waits.push(ms),
  }), (error) => error === network);
  assert.equal(attempts, 2, "a lost result never starts a new transport attempt");
  assert.deepEqual(waits, [2000], "only the explicit pre-execution rate limit may wait");
  for (const status of [401, 403, 409, 500, 503]) {
    const error = new TrelioApiError(status, "explicit HTTP error");
    await assert.rejects(withEncryptedWorkspaceRequestRetry(async () => { throw error; }, {
      waitForRetry: async () => assert.fail("not 429"),
    }), (caught) => caught === error);
  }
});

test("plain mutation retry reopens bytes only after an explicit pre-execution rate rejection", async (t) => {
  let status = 429;
  let code = "REQUEST_RATE_LIMITED";
  let attempts = 0;
  let factories = 0;
  let disconnect = false;
  const bodies = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks));
    attempts++;
    if (disconnect) { request.socket.destroy(); return; }
    response.setHeader("content-type", "application/json");
    response.setHeader("retry-after", "0");
    response.statusCode = status;
    response.end(JSON.stringify({ code, message: "synthetic response" }));
    // A known 429 is a refused attempt: no mutation happened before this point.
    if (status === 429 && code === "REQUEST_RATE_LIMITED") status = 200;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const immutableBytes = Buffer.from("immutable candidate bundle fixture");
  const save = () => requestWithRateLimitRetry({
    origin, token: "synthetic-token", pathname: "/save", rejectedBeforeExecutionOnly: true,
    createOptions: () => {
      factories++;
      return { method: "POST", duplex: "half", body: Readable.from([immutableBytes]) };
    },
  });
  assert.equal((await save()).status, 200);
  assert.equal(attempts, 2);
  assert.equal(factories, 2);
  assert.deepEqual(bodies, [immutableBytes, immutableBytes]);
  // Unknown upstream 429, explicit auth/conflict/server errors and a lost
  // response are ambiguous or terminal. They must never create another record.
  for (const nextStatus of [429, 401, 403, 409, 500, 503]) {
    status = nextStatus;
    code = nextStatus === 429 ? "UNKNOWN_PROXY_RATE_LIMIT" : "REQUEST_RATE_LIMITED";
    const previous = attempts;
    await assert.rejects(save(), { statusCode: nextStatus });
    assert.equal(attempts, previous + 1);
    assert.equal(factories, attempts);
  }
  disconnect = true;
  const previous = attempts;
  await assert.rejects(save(), /transport|fetch|сети/iu);
  assert.equal(attempts, previous + 1);
});
