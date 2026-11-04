/** Personal new-chat navigation. This never creates a Run, starts a model
 * turn, changes a folder binding or treats a task's company as folder proof. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readManagedBinding } from "./trelio-folder-onboarding.mjs";

export const codexLaunchObservationPath = (configDirectory, runtimeSessionId) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(runtimeSessionId))
    ? path.join(configDirectory, "codex-launch-observations", `${runtimeSessionId.toLowerCase()}.json`) : null;

export const removeCodexLaunchObservation = async (configDirectory, runtimeSessionId) => {
  const file = codexLaunchObservationPath(configDirectory, runtimeSessionId);
  if (file) await fs.rm(file, { force: true });
};

export const inspectCodexLaunchFolder = async (cwd, dependencies = {}) => {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || /[\u0000-\u001f\u007f]/u.test(cwd)) return null;
  const bridge = dependencies.bridge ?? await import("./trelio-workspace.mjs");
  const filesystem = dependencies.filesystem ?? fs;
  const selected = path.resolve(cwd);
  const stat = await filesystem.lstat(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  const root = await bridge.findTrelioWorkingFolderRoot(selected);
  if (!root) return { state: "unbound", folderPath: selected };
  if ((await filesystem.lstat(root)).isSymbolicLink() || await filesystem.realpath(root) !== root) return null;
  // Respect the client's effective override; a valid AGENTS.md hidden by an
  // unrelated override cannot establish an automatic company association.
  const override = await bridge.readWorkingFolderInstructionFile(path.join(root, "AGENTS.override.md"));
  const markdown = override ?? await bridge.readWorkingFolderInstructionFile(path.join(root, "AGENTS.md"));
  const binding = readManagedBinding(markdown ?? "");
  return binding ? { state: "bound", folderPath: root, ...binding } : null;
};

export const codexLaunchFolderId = (token, origin, folder) => {
  // The backend never receives a dictionary-searchable plaintext path hash.
  // A device credential keys this opaque identity; a re-pair gets a new target.
  const bytes = crypto.createHmac("sha256", token).update(JSON.stringify([
    origin, folder.folderPath, folder.company.slug, folder.project?.slug ?? null,
  ])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Best effort under the original hook deadline. Missing/unknown state never
 * triggers pairing, unlock, device registration, local file edits or logging.
 * GET precedes each uncertain PUT; a lost mutation response earns no replay. */
export const synchronizeCodexLaunchFolder = async ({ hookInput, state, origin, toolInput, signal }, dependencies = {}) => {
  if (state.observation?.clientFamily !== "codex" || !hookInput.cwd) return null;
  try {
    const bridge = dependencies.bridge ?? await import("./trelio-workspace.mjs");
    const folder = await inspectCodexLaunchFolder(hookInput.cwd, { ...dependencies, bridge });
    if (!folder) return null;
    const memoKey = crypto.createHash("sha256").update(JSON.stringify([
      origin, state.runtimeSessionId, folder.folderPath, folder.company?.slug, folder.project?.slug,
    ])).digest("hex");
    const memoPath = codexLaunchObservationPath(bridge.resolveWorkspaceBridgeConfigDirectory(), state.runtimeSessionId);
    if (!memoPath) return null;
    const previous = await bridge.readPrivateJsonFile(memoPath, { maximumBytes: 2048 });
    // One bounded companion per runtime session follows ordinary lifecycle
    // cleanup. Unknown private state is preserved rather than overwritten.
    if (Object.keys(previous).length && (previous.schemaVersion !== 1
      || previous.expiresAt !== state.expiresAt || !Array.isArray(previous.observed)
      || previous.observed.length > 16 || previous.observed.some(key => !/^[0-9a-f]{64}$/u.test(key)))) return null;
    const observed = previous.observed ?? [];
    if (observed.includes(memoKey) || observed.length >= 16) return null;
    const remember = () => bridge.writePrivateJsonFile(memoPath, {
      schemaVersion: 1, expiresAt: state.expiresAt, observed: [...observed, memoKey],
    });
    if (folder.state === "unbound") {
      if (!toolInput?.companySlug) return null;
      await remember();
      return `Only during explicitly requested Trelio business work: the client-selected folder ${JSON.stringify(folder.folderPath)} has no confirmed company binding. After a successful exact read of company ${JSON.stringify(toolInput.companySlug)}, ask once in the user's language whether to use this folder for that company's new Codex chats. Show the complete company name and absolute folder path. Only an affirmative user answer authorizes the existing folder_onboarding plan/apply for this exact folder and company. A refusal writes nothing. Repository development, audit and diagnostics do not authorize business folder binding. Never create a Run just to register a folder.`;
    }
    // loadToken only reads the already paired credential. requireToken would
    // be wrong here: an optional navigation feature must not initiate setup.
    const token = await bridge.loadToken(origin, { signal });
    if (!token || !token.startsWith("twb_")) return null;
    signal?.throwIfAborted();
    const id = codexLaunchFolderId(token, origin, folder);
    const routing = await bridge.resolveBridgeDataPlaneRouting({ origin, token, companySlug: folder.company.slug, signal });
    const endpoint = `/api/agent-workspaces/companies/${encodeURIComponent(folder.company.slug)}/codex-folders`;
    const snapshot = await (await bridge.request(routing.requestOrigin, token, endpoint, { signal })).json();
    if (!Array.isArray(snapshot?.folders)) return null;
    if (snapshot.folders.some(item => item.id === id)) { await remember(); return null; }
    const companyEncryption = routing.encryptionState === "plain" ? null : await bridge.ensureCompanyEncryptionContext({
      origin, requestOrigin: routing.requestOrigin, token, company: folder.company, existingOnly: true, signal,
    });
    // An encryption transition between routing and runtime never falls back.
    if ((routing.encryptionState === "encrypted") !== Boolean(companyEncryption)) return null;
    let folderPath = folder.folderPath;
    if (companyEncryption) {
      const local = dependencies.local ?? await import("./trelio-local-context.mjs");
      const protectedValues = await local.protectLocalActionArguments({ nativeTool: "register_codex_folder",
        arguments: { clientRequestId: id, folderPath }, companyEncryption });
      await local.uploadLocalActionPayloads({ origin: routing.requestOrigin, token, companyEncryption,
        payloads: protectedValues.payloads, expectedPayloadValues: protectedValues.expectedPayloadValues, signal });
      folderPath = protectedValues.value.folderPath;
    }
    signal?.throwIfAborted();
    const result = await (await bridge.request(routing.requestOrigin, token, `${endpoint}/${id}`, {
      method: "PUT", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ runtimeSessionId: state.runtimeSessionId, folderPath,
        platform: process.platform, ...(folder.project ? { projectSlug: folder.project.slug } : {}) }),
    })).json();
    if (result?.registered === true && result.id === id) await remember();
    return null;
  } catch { return null; }
};
