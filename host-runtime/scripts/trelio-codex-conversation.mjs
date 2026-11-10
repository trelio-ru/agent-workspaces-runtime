/** Optional Codex navigation and Run metadata. No model turn or chat inventory. */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ENV_KEYS = ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "CODEX_HOME"];
const titleEnvironment = (environment, { platform = process.platform } = {}) => {
  const selected = Object.fromEntries(ENV_KEYS
    .filter((key) => typeof environment[key] === "string")
    .map((key) => [key, environment[key]]));
  if (platform === "win32") {
    // Codex starts bundled MCP processes itself. Its ordinary Windows .cmd
    // discovery/interpreter needs these public OS process variables even when
    // the model child receives a narrowed environment. Losing them can select
    // the extensionless POSIX launcher and fail with Windows error 193 before
    // MCP initialize. This preserves the same launcher, never shell:true or a
    // second resolver, and still excludes credentials and inherited chat IDs.
    for (const canonical of ["ComSpec", "PATHEXT"]) {
      const values = Object.entries(environment)
        .filter(([key, value]) => key.toLowerCase() === canonical.toLowerCase() && typeof value === "string")
        .map(([, value]) => value);
      // A native Windows environment has case-insensitive names. Normalize to
      // one child key; an inconsistent synthetic map must not choose an alias.
      if (values.length && new Set(values).size === 1) selected[canonical] = values[0];
    }
  }
  return selected;
};

/** A fixed public AppModel query in the SAME signed worker. It accepts no
 * package/path/PID selector and never enters the ACL/DPAPI request protocol.
 * Raw child errors and paths never become diagnostic messages. */
export const readWindowsCodexPackagePath = async ({signal=AbortSignal.timeout(5000),spawnProcess=spawn,selectWorker}={}) => {
  if(signal?.aborted)return null;
  try{
    const selected=await (selectWorker??(async()=>{
      const {windowsPrivateWorkerOptions}=await import('./trelio-hook-private-session.mjs');return windowsPrivateWorkerOptions();
    }))();
    if(signal?.aborted)return null;
    return await new Promise(resolve=>{
      let child,done=false,output='';const end=value=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);child?.kill();resolve(value);};
      const abort=()=>end(null);signal?.addEventListener('abort',abort,{once:true});
      try{
        child=spawnProcess(selected.executable,['--codex-package-path'],{shell:false,windowsHide:true,stdio:['ignore','pipe','ignore'],
          env:{SystemRoot:process.env.SystemRoot??process.env.SYSTEMROOT??'C:\\Windows',PATH:''}});
        child.once('error',abort);child.stdout.on('error',abort);
        child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(Buffer.byteLength(output)>24_000)abort();});
        child.once('close',code=>{
          if(done)return;if(code!==0||signal?.aborted)return end(null);
          try{const value=JSON.parse(output),keys=Object.keys(value).sort().join(',');
            if(value.schemaVersion!==1||value.state!=='available'||keys!=='pathBase64,schemaVersion,state'
              ||typeof value.pathBase64!=='string'||value.pathBase64.length>22_000)return end(null);
            const bytes=Buffer.from(value.pathBase64,'base64'),directory=bytes.toString('utf8');
            if(bytes.toString('base64')!==value.pathBase64||!Buffer.from(directory,'utf8').equals(bytes)
              ||!/^[a-z]:[\\/]/iu.test(directory)||/[\x00-\x1f\x7f]/u.test(directory))return end(null);
            end(directory);
          }catch{end(null);}
        });
      }catch{end(null);}
    });
  }catch{return null;}
};

const WINDOWS_CODEX_FILES=['codex.exe','codex-code-mode-host.exe','codex-windows-sandbox-setup.exe','codex-command-runner.exe'];
/** Vendor relocation selection observed in the installed public desktop
 * resource. This is NOT a search through cache versions: the current user's
 * exact registered Store package supplies four immutable source binaries.
 * Their ordered filename/NUL/SHA256hex/NUL digest chooses one exact copy.
 * We verify that existing copy only; never relocate, repair, execute Store
 * internals or change an ACL. A package update invalidates this observation.
 */
const resolveWindowsDesktopCodex = async (environment,{filesystem,signal,readPackagePath}) => {
  const win=path.win32,equal=(a,b)=>win.normalize(a).toLowerCase()===win.normalize(b).toLowerCase();
  const local=value=>typeof value==='string'&&/^[a-z]:\\/iu.test(value)&&!/[\x00-\x1f\x7f]/u.test(value);
  try{
    if(!local(environment.LOCALAPPDATA))return null;
    signal?.throwIfAborted();const packageRoot=await readPackagePath({signal});if(!local(packageRoot))return null;
    const realPackage=await filesystem.realpath(packageRoot),realLocal=await filesystem.realpath(environment.LOCALAPPDATA);
    if(!equal(realPackage,packageRoot))return null;
    const directories=async(root,parts)=>{
      let current=root;
      for(const part of ['',...parts]){if(part)current=win.join(current,part);signal?.throwIfAborted();
        const stat=await filesystem.lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory()
          ||!equal(await filesystem.realpath(current),current))throw Error('unavailable');}
      return current;
    };
    const sourceRoot=await directories(realPackage,['app','resources']);
    const copyRoot=await directories(realLocal,['OpenAI','Codex','bin']);
    const hashFile=async candidate=>{
      signal?.throwIfAborted();const before=await filesystem.lstat(candidate);
      if(before.isSymbolicLink()||!before.isFile()||before.size<1||before.size>512*1024*1024
        ||!equal(await filesystem.realpath(candidate),candidate))throw Error('unavailable');
      const handle=await filesystem.open(candidate,'r');const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
      let total=0;try{for(;;){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;
        total+=bytesRead;if(total>before.size)throw Error('unavailable');hash.update(buffer.subarray(0,bytesRead));}}
      finally{await handle.close();}
      const after=await filesystem.lstat(candidate);signal?.throwIfAborted();
      if(total!==before.size||after.isSymbolicLink()||!after.isFile()||!equal(await filesystem.realpath(candidate),candidate)
        ||['size','mtimeMs','ctimeMs','ino','dev'].some(key=>after[key]!==before[key]))throw Error('unavailable');
      return {size:total,digest:hash.digest('hex')};
    };
    const selectedHash=crypto.createHash('sha256'),sources=[];
    for(const name of WINDOWS_CODEX_FILES){const source=await hashFile(win.join(sourceRoot,name));sources.push(source);
      selectedHash.update(name);selectedHash.update('\0');selectedHash.update(source.digest);selectedHash.update('\0');}
    const selected=await directories(copyRoot,[selectedHash.digest('hex').slice(0,16)]);
    for(let i=0;i<WINDOWS_CODEX_FILES.length;i++){const copy=await hashFile(win.join(selected,WINDOWS_CODEX_FILES[i]));
      if(copy.size!==sources[i].size||copy.digest!==sources[i].digest)return null;}
    signal?.throwIfAborted();const current=await readPackagePath({signal});
    if(!current||!equal(current,packageRoot))return null;
    signal?.throwIfAborted();return win.join(selected,'codex.exe');
  }catch{return null;}
};

/** Official per-user standalone installation, not the Store app's protected
 * internal binary. The installer intentionally uses current/bin junctions.
 * Resolve only that exact visible command and selected release; canonical
 * containment, regular companion files and a final selection read-back allow
 * these documented junctions without accepting an arbitrary reparse target.
 * No cache scan, shell, installation, PATH edit or runtime copy occurs here.
 */
const resolveWindowsStandaloneCodex = async (environment,{filesystem,signal}) => {
  const win=path.win32, local=value=>typeof value==='string'&&/^[a-z]:\\/iu.test(value)&&!/[\x00-\x1f]/u.test(value);
  const equal=(a,b)=>win.normalize(a).toLowerCase()===win.normalize(b).toLowerCase();
  const codexHome=environment.CODEX_HOME || (local(environment.USERPROFILE)?win.join(environment.USERPROFILE,'.codex'):null);
  if(!local(environment.LOCALAPPDATA)||!local(codexHome))return null;
  const root=win.join(codexHome,'packages','standalone'),releases=win.join(root,'releases'),current=win.join(root,'current');
  const visible=win.join(environment.LOCALAPPDATA,'Programs','OpenAI','Codex','bin','codex.exe');
  try{
    signal?.throwIfAborted();
    const realHome=await filesystem.realpath(codexHome),realRoot=await filesystem.realpath(root);
    const realReleases=await filesystem.realpath(releases),selected=await filesystem.realpath(current);
    if(!equal(realRoot,win.join(realHome,'packages','standalone'))||!equal(realReleases,win.join(realRoot,'releases'))
      ||(await filesystem.lstat(root)).isSymbolicLink()||(await filesystem.lstat(releases)).isSymbolicLink())return null;
    signal?.throwIfAborted();
    const releaseName=win.relative(realReleases,selected);
    if(!/^[0-9][a-z0-9._-]{0,159}$/iu.test(releaseName)||!(await filesystem.stat(selected)).isDirectory())return null;
    const executable=await filesystem.realpath(visible);
    if((await filesystem.lstat(visible)).isSymbolicLink())return null;
    const modern=equal(executable,win.join(selected,'bin','codex.exe'));
    if(!modern&&!equal(executable,win.join(selected,'codex.exe')))return null;
    const files=modern?['codex-package.json','bin\\codex.exe','bin\\codex-code-mode-host.exe','codex-path\\rg.exe',
      'codex-resources\\codex-command-runner.exe','codex-resources\\codex-windows-sandbox-setup.exe']
      :['codex.exe','codex-resources\\codex-command-runner.exe','codex-resources\\codex-windows-sandbox-setup.exe','codex-resources\\rg.exe'];
    for(const relative of files){
      signal?.throwIfAborted();const candidate=win.join(selected,relative);
      if(!equal(await filesystem.realpath(candidate),candidate)||(await filesystem.lstat(candidate)).isSymbolicLink()
        ||!(await filesystem.stat(candidate)).isFile())return null;
    }
    // A concurrent installer retarget is not permission to combine two releases
    // or retry discovery. The next ordinary invocation can observe it afresh.
    if(!equal(await filesystem.realpath(current),selected)||!equal(await filesystem.realpath(visible),executable))return null;
    signal?.throwIfAborted();return executable;
  }catch{return null;}
};

const resolveCodexExecutable = async (environment,{platform=process.platform,filesystem=fs,signal=AbortSignal.timeout(15_000),readPackagePath=readWindowsCodexPackagePath}={}) => {
  const paths=platform==='win32'?path.win32:path.posix;
  const filename = platform === "win32" ? "codex.exe" : "codex";
  const candidates = (environment.PATH || (platform==='win32'?environment.Path:'') || "").split(paths.delimiter)
    .filter((directory) => paths.isAbsolute(directory)).map((directory) => paths.join(directory, filename));
  // Desktop may launch MCP with a restricted PATH. These are exact standard
  // bundle locations, not a search through another app's private chat storage.
  if (platform === "darwin") {
    for (const app of ["ChatGPT", "Codex"]) {
      candidates.push(`/Applications/${app}.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`);
    }
  }
  for (const candidate of candidates) {
    try {
      signal?.throwIfAborted();const executable = await filesystem.realpath(candidate);
      if ((await filesystem.stat(executable)).isFile()&&!signal?.aborted) return executable;
    } catch { /* An unavailable CLI leaves the existing generic label intact. */ }
  }
  if(signal?.aborted)return null;
  if(platform!=='win32')return null;
  const desktop=await resolveWindowsDesktopCodex(environment,{filesystem,signal,readPackagePath});
  if(desktop||signal?.aborted)return desktop;
  return resolveWindowsStandaloneCodex(environment,{filesystem,signal});
};

/**
 * Read only one server-verified ID through Codex's documented App Server.
 * includeTurns=false prevents transcript retrieval; thread/read does not
 * resume a thread, subscribe to it, or start a model. Suppress stderr because
 * even a local CLI diagnostic can include private config or content.
 */
export const readCodexConversationTitle = async (conversationId, {
  environment = process.env,
  executable,
  spawnProcess = spawn,
  signal,
  timeoutMs = 3000,
} = {}) => {
  if (!UUID.test(String(conversationId)) || signal?.aborted) return null;
  const deadline=AbortSignal.timeout(timeoutMs);signal=signal?AbortSignal.any([signal,deadline]):deadline;
  const started=performance.now();
  const resolvedExecutable = executable || await resolveCodexExecutable(environment,{signal});
  if (!resolvedExecutable || signal?.aborted) return null;
  const remaining=timeoutMs-(performance.now()-started);if(remaining<=0)return null;
  return new Promise((resolve) => {
    let child;
    let done = false;
    let timer;
    let pending = "";
    let bytes = 0;
    let initialized = false;
    const finish = (title = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child?.stdin.destroy();
      child?.stdout.destroy();
      // A separate App Server is short-lived even after success. Never leave
      // a background subscriber/process behind to watch future renames.
      child?.kill("SIGKILL");
      resolve(title);
    };
    const abort = () => finish();
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    try {
      child = spawnProcess(resolvedExecutable, ["app-server", "--listen", "stdio://"], {
        env: titleEnvironment(environment), shell: false, windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      timer = setTimeout(abort, remaining);
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", abort);
      child.on("exit", abort);
      child.stdin.on("error", abort);
      child.stdout.on("error", abort);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256 * 1024) return finish();
        pending += chunk;
        let newline;
        while (!done && (newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { return finish(); }
          if (message.id === 1 && !initialized) {
            if (message.error || !message.result) return finish();
            initialized = true;
            send({ method: "initialized" });
            send({ id: 2, method: "thread/read", params: { threadId: conversationId, includeTurns: false } });
          } else if (message.id === 2 && initialized) {
            const thread = message.result?.thread;
            const title = typeof thread?.name === "string" ? thread.name.trim() : "";
            return finish(!message.error && thread?.id === conversationId && title && title.length <= 500 ? title : null);
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "trelio_chat_title", version: "1.0.0" } } });
    } catch { finish(); }
  });
};

/**
 * Every attempt starts from live private Run metadata, never CODEX_THREAD_ID.
 * Compare the hydrated existing title before encryption/upload. An ambiguous
 * write is not replayed; the next lifecycle event reads the live state anew.
 * Dependencies receive one deadline, so optional metadata cannot hold up work.
 */
export const syncRunCodexConversationTitle = async ({
  readConversation, readTitle = readCodexConversationTitle, protectTitle, writeTitle,
  timeoutMs = 6000,
}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { signal } = controller;
  try {
    const conversation = await readConversation(signal);
    if (!conversation || !UUID.test(String(conversation.conversationId))
      || !/^[0-9a-f]{64}$/u.test(String(conversation.expectedStateHash))) return false;
    const title = await readTitle(conversation.conversationId, { signal });
    if (signal.aborted || typeof title !== "string" || !title.trim() || title.trim().length > 500
      || title.trim() === conversation.title) return false;
    const protectedTitle = await protectTitle(title.trim(), signal);
    if (signal.aborted) return false;
    await writeTitle({ conversationId: conversation.conversationId,
      expectedStateHash: conversation.expectedStateHash, title: protectedTitle }, signal);
    return true;
  } catch {
    // Old backend/CLI, offline, denied ACL, stale CAS or unavailable E2EE keys
    // all preserve the successful core Run operation. No auth recovery, fallback
    // transport, stdout title, model instruction or persistent plaintext cache.
    return false;
  } finally { clearTimeout(timer); }
};

// Shared discovery/environment boundary for the assistant native adapter.
export { resolveCodexExecutable, titleEnvironment as buildCodexEnvironment };

/** Personal launch navigation shares this existing Codex boundary so the signed
 * package retains its fixed file ceiling. It creates no Run or model turn and
 * never treats the current task as proof of a filesystem/company binding. */
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
  const { readManagedBinding } = await import("./trelio-folder-onboarding.mjs");
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
export const synchronizeCodexLaunchFolder = async ({ hookInput, state, origin, signal }, dependencies = {}) => {
  if (state.observation?.clientFamily !== "codex" || !hookInput.cwd) return null;
  try {
    const bridge = dependencies.bridge ?? await import("./trelio-workspace.mjs");
    const folder = await inspectCodexLaunchFolder(hookInput.cwd, { ...dependencies, bridge });
    // Navigation may reuse an explicit managed binding, but reading a task
    // does not request initial folder setup. A selected Codex project can be
    // an ordinary Git repository, which the onboarding classifier correctly
    // refuses to adopt. Asking from this hook sent every new chat through that
    // unrelated setup failure; a session memo only hid repeats in one chat.
    // Stop before private state, credentials or network access. Explicit setup
    // keeps the existing consent/Git/CAS flow; do not infer scope from a task.
    if (folder?.state !== "bound") return null;
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
    // loadToken only reads the already paired credential. requireToken would
    // be wrong here: an optional navigation feature must not initiate setup.
    const token = await bridge.loadToken(origin, { signal });
    if (!token || !token.startsWith("twb_")) return null;
    signal?.throwIfAborted();
    await registerAndVerifyCodexLaunchFolder({ origin, token, folder, state, signal, readBack: false }, dependencies);
    await remember();
    return null;
  } catch { return null; }
};

/** Explicit setup shares the hook's immutable registration algorithm, but it
 * requires a positive GET read-back. A lost PUT response is reconciled once by
 * GET, never blindly replayed. An encrypted path is hydrated only locally. */
export const registerAndVerifyCodexLaunchFolder = async ({ origin, token, folder, state, signal,
  readBack = true, interactive = false }, dependencies = {}) => {
  const bridge = dependencies.bridge ?? await import("./trelio-workspace.mjs");
  const id = codexLaunchFolderId(token, origin, folder);
  const routing = await bridge.resolveBridgeDataPlaneRouting({ origin, token, companySlug: folder.company.slug, signal });
  if (!["plain", "encrypted"].includes(routing.encryptionState)) throw wizardError("COMPANY_ENCRYPTION_TRANSITION");
  const endpoint = `/api/agent-workspaces/companies/${encodeURIComponent(folder.company.slug)}/codex-folders`;
  const read = async () => {
    const snapshot = await (await bridge.request(routing.requestOrigin, token, endpoint, { signal })).json();
    if (!Array.isArray(snapshot?.folders)) throw wizardError("CODEX_CONNECTION_INVALID_RESPONSE");
    return snapshot.folders.find(item => item.id === id) ?? null;
  };
  let existing = await read();
  let companyEncryption = null;
  if ((!existing || readBack) && routing.encryptionState === "encrypted") {
    companyEncryption = await bridge.ensureCompanyEncryptionContext({ origin, requestOrigin: routing.requestOrigin,
      token, company: folder.company, existingOnly: !interactive, signal });
    if (!companyEncryption) throw wizardError("CODEX_CONNECTION_ENCRYPTION_REQUIRED");
  }
  if (!existing) {
    let folderPath = folder.folderPath;
    if (companyEncryption) {
      const local = dependencies.local ?? await import("./trelio-local-context.mjs");
      const protectedValues = await local.protectLocalActionArguments({ nativeTool: "register_codex_folder",
        arguments: { clientRequestId: id, folderPath }, companyEncryption });
      await local.uploadLocalActionPayloads({ origin: routing.requestOrigin, token, companyEncryption,
        payloads: protectedValues.payloads, expectedPayloadValues: protectedValues.expectedPayloadValues, signal });
      folderPath = protectedValues.value.folderPath;
    }
    try {
      const result = await (await bridge.request(routing.requestOrigin, token, `${endpoint}/${id}`, {
        method: "PUT", headers: { "content-type": "application/json" }, signal,
        body: JSON.stringify({ runtimeSessionId: state.runtimeSessionId, folderPath,
          platform: process.platform, ...(folder.project ? { projectSlug: folder.project.slug } : {}) }),
      })).json();
      if (result?.registered !== true || result.id !== id) throw wizardError("CODEX_CONNECTION_INVALID_RESPONSE");
    } catch (error) {
      if (!readBack || signal?.aborted) throw error;
      existing = await read();
      if (!existing) throw wizardError("CODEX_CONNECTION_REGISTRATION_UNCONFIRMED");
    }
    if (!readBack) return { id, registered: true };
    existing ??= await read();
  }
  if (readBack) {
    const opened = companyEncryption ? await bridge.hydrateAgentCompanyEncryptedJson({ value: existing,
      origin: routing.requestOrigin, token, companyEncryption, signal }) : existing;
    if (!opened || opened.id !== id || opened.folderPath !== folder.folderPath
      || opened.platform !== process.platform || (!folder.project && opened.projectId != null)) {
      throw wizardError("CODEX_CONNECTION_READBACK_FAILED");
    }
  }
  return { id, registered: true, verified: readBack };
};

const wizardError = code => Object.assign(new Error(code), { code });

// The wizard belongs to the signed runtime, alongside existing Codex folder
// navigation. It neither changes the stable plugin shell nor uses a business Run.
export const CODEX_CONNECTION_RESOURCE = "ui://trelio/codex-connection-v1.html";
export const CODEX_CONNECTION_ACTION = "codex_connection_app_action";
const wizardCapabilities = new Map();
const wizardBusy = new Set();
const WIZARD_LIFETIME_MS = 30 * 60 * 1000;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const safeFolderPath = value => typeof value === "string" && value.length <= 4096
  && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value)
  && path.resolve(value) !== path.parse(value).root;
const safeConnectionName = value => typeof value === "string" && value.trim().length > 0
  && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Native modal child has no input channel. Capture bounded bytes and settle
 * only after close: an early exit, abort or output overflow cannot leave a live
 * dialog behind while the App enables another picker or claim partial success. */
export const runCodexFolderPickerProcess = (file, args, options) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  let bytes = 0, failure = null;
  const collect = target => chunk => {
    if (failure) return;
    bytes += chunk.length;
    if (bytes > (options.maxBuffer ?? 16_384)) {
      failure = wizardError("CODEX_CONNECTION_PICKER_OUTPUT_LIMIT"); child.kill(); return;
    }
    target.push(Buffer.from(chunk));
  };
  child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
  child.on("error", error => { failure = error; });
  child.on("close", (code, signal) => {
    const output = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
    if (failure) reject(failure);
    else if (code !== 0 || signal) reject(Object.assign(new Error("Native folder picker did not finish."), { code, stderr: output.stderr }));
    else resolve(output);
  });
});

/** Fixed native programs and fixed scripts only. User paths/names never become
 * shell source, AppleScript/PowerShell code, a prompt, an environment or a log.
 * Cancellation preserves the form; unavailable GUI leaves manual path input. */
export const chooseCodexConnectionFolder = async ({ signal, platform = process.platform,
  environment = process.env, filesystem = fs, run = null } = {}) => {
  run ??= runCodexFolderPickerProcess;
  let executable, args;
  if (platform === "darwin") {
    executable = "/usr/bin/osascript";
    args = ["-e", 'POSIX path of (choose folder with prompt "Выберите отдельную рабочую папку Trelio")'];
  } else if (platform === "win32") {
    if (typeof environment.SystemRoot !== "string" || !path.win32.isAbsolute(environment.SystemRoot)) {
      throw wizardError("CODEX_CONNECTION_PICKER_UNAVAILABLE");
    }
    executable = path.win32.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description="Выберите отдельную рабочую папку Trelio"; try { if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.SelectedPath)} } finally {$d.Dispose()}';
    args = ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  } else if (platform === "linux") {
    if (await filesystem.access("/usr/bin/zenity").then(() => true, () => false)) {
      executable = "/usr/bin/zenity"; args = ["--file-selection", "--directory", "--title=Рабочая папка Trelio"];
    } else if (await filesystem.access("/usr/bin/kdialog").then(() => true, () => false)) {
      executable = "/usr/bin/kdialog"; args = ["--getexistingdirectory", ".", "--title", "Рабочая папка Trelio"];
    } else throw wizardError("CODEX_CONNECTION_PICKER_UNAVAILABLE");
  } else throw wizardError("CODEX_CONNECTION_PICKER_UNAVAILABLE");
  try {
    const result = await run(executable, args, { shell: false, windowsHide: true, timeout: 45_000,
      maxBuffer: 16_384, encoding: "utf8", signal, stdio: ["ignore", "pipe", "pipe"], env: titleEnvironment(environment, { platform }) });
    // Remove the native record delimiter, never meaningful path whitespace.
    const selected = String(result.stdout ?? "").replace(/\r?\n$/u, "");
    if (!selected) return null;
    const nativePath = platform === "win32" ? path.win32 : path.posix;
    if (!nativePath.isAbsolute(selected) || selected.length > 4096 || /[\u0000-\u001f\u007f]/u.test(selected)) {
      throw wizardError("CODEX_CONNECTION_PICKER_INVALID");
    }
    return nativePath.normalize(selected);
  } catch (error) {
    if ((platform === "linux" && error?.code === 1)
      || (platform === "darwin" && /\(-128\)/u.test(String(error?.stderr ?? "")))) return null;
    throw wizardError("CODEX_CONNECTION_PICKER_UNAVAILABLE");
  }
};

const wizardDependencies = async dependencies => ({
  bridge: dependencies.bridge ?? await import("./trelio-workspace.mjs"),
  filesystem: dependencies.filesystem ?? fs,
});
const liveWizardContext = async (origin, parameters, dependencies, signal) => {
  const { bridge } = await wizardDependencies(dependencies);
  const token = await bridge.loadToken(origin, { signal });
  if (!token?.startsWith("twb_")) throw wizardError("CODEX_CONNECTION_PAIRING_REQUIRED");
  const routing = await bridge.resolveBridgeDataPlaneRouting({ origin, token, companySlug: parameters.companySlug, signal });
  if (!["plain", "encrypted"].includes(routing.encryptionState)) throw wizardError("COMPANY_ENCRYPTION_TRANSITION");
  const endpoint = `/api/agent-workspaces/companies/${encodeURIComponent(parameters.companySlug)}/codex-connection?runtimeSessionId=${parameters.runtimeSessionId}`;
  const context = await (await bridge.request(routing.requestOrigin, token, endpoint, { signal })).json();
  if (context?.company?.slug !== parameters.companySlug || !UUID.test(context?.company?.id ?? "")
    || !UUID.test(context?.memberId ?? "") || typeof context.company.name !== "string"
    || context.company.name.length > 255 || context.encryptionState !== routing.encryptionState) {
    throw wizardError("CODEX_CONNECTION_INVALID_RESPONSE");
  }
  return { context, token, bridge };
};
const wizardBindingKey = (origin, token, context) => crypto.createHmac("sha256", token)
  .update(`${origin}\n${context.company.id}\n${context.memberId}`).digest("hex");
const wizardResult = (capabilityToken, capability, state, mount = false) => ({
  content: [{ type: "text", text: state.stage === "ready"
    ? "Codex connection verified: the selected folder was registered in Trelio and read back."
    : "Codex connection wizard is open. Complete the folder selection in the App." }],
  structuredContent: { stage: state.stage, verified: state.stage === "ready" },
  _meta: { ...(mount ? { ui: { resourceUri: CODEX_CONNECTION_RESOURCE }, "openai/outputTemplate": CODEX_CONNECTION_RESOURCE } : {}),
    "trelio/codexConnection": { capabilityToken, companyName: capability.company.name, ...state } },
});

export const openCodexConnectionWizard = async (origin, raw, dependencies = {}) => {
  if (!object(raw) || raw.schemaVersion !== 1 || raw.operation !== "codex_connection_open"
    || Object.keys(raw).some(key => !["schemaVersion", "operation", "parameters"].includes(key))
    || !object(raw.parameters) || Object.keys(raw.parameters).some(key => !["companySlug", "runtimeSessionId"].includes(key))
    || typeof raw.parameters.companySlug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,119}$/u.test(raw.parameters.companySlug)
    || !UUID.test(raw.parameters.runtimeSessionId ?? "")) throw wizardError("CODEX_CONNECTION_INVALID_INPUT");
  const { context, token, bridge } = await liveWizardContext(origin, raw.parameters, dependencies, dependencies.signal);
  const key = wizardBindingKey(origin, token, context);
  const stateFile = path.join(bridge.resolveWorkspaceBridgeConfigDirectory(), "codex-connections", `${key}.json`);
  const previous = await bridge.readPrivateJsonFile(stateFile, { maximumBytes: 16_384 });
  if (Object.keys(previous).length && (previous.schemaVersion !== 1 || !safeFolderPath(previous.folderPath)
    || !safeConnectionName(previous.displayName) || typeof previous.createFolder !== "boolean")) {
    throw wizardError("CODEX_CONNECTION_LOCAL_STATE_INVALID");
  }
  const { homedir } = await import("node:os");
  const state = { stage: "folder", folderPath: previous.folderPath ?? path.join(homedir(), "Documents", "Trelio", context.company.slug),
    displayName: previous.displayName ?? `Trelio · ${context.company.name}`.slice(0, 199).replace(/[\uD800-\uDBFF]$/u, ""),
    createFolder: previous.createFolder ?? true };
  const now = Date.now();
  for (const [key, value] of wizardCapabilities) if (value.expiresAt <= now) wizardCapabilities.delete(key);
  if (wizardCapabilities.size >= 32) throw wizardError("CODEX_CONNECTION_LIMIT");
  const capabilityToken = crypto.randomBytes(32).toString("base64url");
  const capability = { origin, parameters: raw.parameters, company: context.company, memberId: context.memberId, stateFile, state,
    busyKey: key, expiresAt: now + WIZARD_LIFETIME_MS };
  wizardCapabilities.set(capabilityToken, capability);
  return wizardResult(capabilityToken, capability, state, true);
};

/** Walk every existing ancestor without following symlinks. Recursive mkdir is
 * allowed only by the App's explicit create choice, then the planner rechecks
 * the actual root and its Git ownership before any instruction write. */
const prepareWizardDirectory = async (folderPath, createFolder, filesystem, signal) => {
  const root = path.parse(folderPath).root;
  let current = root;
  for (const part of path.relative(root, folderPath).split(path.sep)) {
    signal?.throwIfAborted();
    current = path.join(current, part);
    let stat;
    try { stat = await filesystem.lstat(current); }
    catch (error) {
      if (error.code !== "ENOENT" || !createFolder) throw wizardError("CODEX_CONNECTION_FOLDER_UNAVAILABLE");
      await filesystem.mkdir(current, { mode: 0o700 });
      stat = await filesystem.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw wizardError("CODEX_CONNECTION_FOLDER_UNSAFE");
  }
  if (await filesystem.realpath(folderPath) !== folderPath) throw wizardError("CODEX_CONNECTION_FOLDER_UNSAFE");
};

export const handleCodexConnectionAction = async (origin, input, dependencies = {}) => {
  if (!object(input) || Object.keys(input).some(key => !["capabilityToken", "action", "settings"].includes(key))
    || !["state", "pick", "save", "connect"].includes(input.action)) throw wizardError("CODEX_CONNECTION_INVALID_INPUT");
  const cap = wizardCapabilities.get(input.capabilityToken);
  if (!cap || cap.origin !== origin || cap.expiresAt <= Date.now()) throw wizardError("CODEX_CONNECTION_EXPIRED");
  if (wizardBusy.has(cap.busyKey)) throw wizardError("CODEX_CONNECTION_BUSY");
  wizardBusy.add(cap.busyKey);
  try {
    // Expiry, revoked membership, bridge grant and model policy are independent
    // of the hidden local capability and are checked again before every action.
    const { context, bridge, token } = await liveWizardContext(origin, cap.parameters, dependencies, dependencies.signal);
    const liveKey = wizardBindingKey(origin, token, context);
    if (context.company.id !== cap.company.id || context.memberId !== cap.memberId || liveKey !== cap.busyKey) {
      throw wizardError("CODEX_CONNECTION_SCOPE_CHANGED");
    }
    dependencies.signal?.throwIfAborted();
    const { filesystem } = await wizardDependencies(dependencies);
    if (input.settings !== undefined) {
      if (!["save", "pick", "connect"].includes(input.action) || !object(input.settings)
        || Object.keys(input.settings).some(key => !["folderPath", "displayName", "createFolder"].includes(key))
        || !safeFolderPath(input.settings.folderPath) || !safeConnectionName(input.settings.displayName)
        || typeof input.settings.createFolder !== "boolean") throw wizardError("CODEX_CONNECTION_INVALID_INPUT");
      cap.state = { stage: "folder", folderPath: path.resolve(input.settings.folderPath),
        displayName: input.settings.displayName.trim(), createFolder: input.settings.createFolder };
    }
    // Persist the user's typed choice before opening a native modal. A cancel,
    // unavailable GUI or interrupted modal must not lose the edited name/path.
    if (input.settings !== undefined) await bridge.writePrivateJsonFile(cap.stateFile, {
      schemaVersion: 1, folderPath: cap.state.folderPath, displayName: cap.state.displayName, createFolder: cap.state.createFolder,
    });
    if (input.action === "pick") {
      const selected = await (dependencies.chooseFolder ?? chooseCodexConnectionFolder)({ signal: dependencies.signal });
      if (selected) {
        if (!safeFolderPath(selected)) throw wizardError("CODEX_CONNECTION_INVALID_INPUT");
        cap.state = { ...cap.state, stage: "folder", folderPath: selected, createFolder: false };
      }
    }
    if (input.action === "pick") await bridge.writePrivateJsonFile(cap.stateFile, {
      schemaVersion: 1, folderPath: cap.state.folderPath, displayName: cap.state.displayName, createFolder: cap.state.createFolder,
    });
    if (input.action === "state" && cap.state.stage === "ready") {
      cap.state.stage = "folder"; delete cap.state.openUrl;
    }
    if (input.action === "connect") {
      // A previously rendered success never grants a blind registration replay.
      // The same deterministic ID and fresh GET reconcile interrupted setup.
      cap.state.stage = "checking";
      await prepareWizardDirectory(cap.state.folderPath, cap.state.createFolder, filesystem, dependencies.signal);
      const folderModule = dependencies.onboarding ?? await import("./trelio-folder-onboarding.mjs");
      const existing = await inspectCodexLaunchFolder(cap.state.folderPath, { bridge, filesystem });
      if (existing?.state === "bound" && (existing.company.slug !== cap.company.slug || existing.project)) {
        throw wizardError("CODEX_CONNECTION_BINDING_CONFLICT");
      }
      const plan = await folderModule.prepareTrelioFolderOnboarding({ folderPath: cap.state.folderPath, company: cap.company });
      if (!plan.plan) throw wizardError("CODEX_CONNECTION_FOLDER_REVIEW_REQUIRED");
      dependencies.signal?.throwIfAborted();
      if (plan.plan.apply) await folderModule.applyTrelioFolderOnboarding(plan.plan.apply.arguments.parameters);
      const folder = await inspectCodexLaunchFolder(cap.state.folderPath, { bridge, filesystem });
      if (folder?.state !== "bound" || folder.company.slug !== cap.company.slug || folder.project) {
        throw wizardError("CODEX_CONNECTION_BINDING_UNCONFIRMED");
      }
      dependencies.signal?.throwIfAborted();
      cap.state.stage = "registering";
      const receipt = await (dependencies.register ?? registerAndVerifyCodexLaunchFolder)({ origin, token, folder,
        state: { runtimeSessionId: cap.parameters.runtimeSessionId }, signal: dependencies.signal, interactive: true }, dependencies);
      if (receipt?.verified !== true) throw wizardError("CODEX_CONNECTION_REGISTRATION_UNCONFIRMED");
      const verifiedFolder = await inspectCodexLaunchFolder(cap.state.folderPath, { bridge, filesystem });
      if (verifiedFolder?.state !== "bound" || verifiedFolder.folderPath !== folder.folderPath
        || verifiedFolder.company.slug !== cap.company.slug || verifiedFolder.project) {
        throw wizardError("CODEX_CONNECTION_BINDING_UNCONFIRMED");
      }
      // Registration read-back and local CAS are distinct from live admission.
      // A policy/account change during HTTP must not leave an old green screen.
      const finalContext = await liveWizardContext(origin, cap.parameters, dependencies, dependencies.signal);
      if (wizardBindingKey(origin, finalContext.token, finalContext.context) !== cap.busyKey) {
        throw wizardError("CODEX_CONNECTION_SCOPE_CHANGED");
      }
      dependencies.signal?.throwIfAborted();
      cap.state.stage = "ready";
      const link = new URL("codex://threads/new");
      link.searchParams.set("path", folder.folderPath);
      link.searchParams.set("prompt", `[@Trelio Agent Workspaces](plugin://trelio-agent-workspaces@trelio-plugins) Работаем с компанией Trelio ${cap.company.slug}. Прочитай инструкции выбранной рабочей папки.`);
      cap.state.openUrl = link.href;
    }
    return wizardResult(input.capabilityToken, cap, cap.state);
  } catch (error) {
    cap.state.stage = "folder";
    delete cap.state.openUrl;
    // Paths and native exception text belong only to local IO. Expose closed
    // codes so a permission/network failure cannot leak private directory names.
    const code = /^[A-Z][A-Z0-9_]{2,100}$/u.test(error?.code ?? "") ? error.code : "CODEX_CONNECTION_FAILED";
    return { ...wizardResult(input.capabilityToken, cap, cap.state), isError: true,
      content: [{ type: "text", text: `Codex connection not verified (${code}).` }],
      structuredContent: { stage: "folder", verified: false, code,
        ...(["missing", "invalid", "expired", "replayed"].includes(error?.reason ?? error?.payload?.reason)
          ? { reason: error?.reason ?? error?.payload?.reason } : {}) },
      _meta: { "trelio/codexConnection": { capabilityToken: input.capabilityToken, companyName: cap.company.name,
        ...cap.state, errorCode: code } } };
  } finally { wizardBusy.delete(cap.busyKey); }
};

/** Offline MCP App: all private values arrive through host-only tool metadata.
 * No fetch, remote scripts, filesystem API or user HTML is available here.
 * Native folder selection and writes are fixed, capability-bound runtime calls. */
export const codexConnectionAppResource = () => ({
  uri: CODEX_CONNECTION_RESOURCE, mimeType: "text/html;profile=mcp-app",
  _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
    "openai/widgetPrefersBorder": false, "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    "openai/widgetDescription": "Мастер подключения Codex: рабочая папка и проверенная регистрация в Trelio." },
  text: String.raw`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключение Codex</title>
<style>
:root{color-scheme:light dark;font:15px/1.5 Arial,sans-serif;color:var(--color-text-primary,light-dark(#20242b,#f1f3f6));background:var(--color-background-primary,light-dark(#fff,#181b20))}*{box-sizing:border-box}body{margin:0;padding:20px}main{max-width:640px;margin:auto}h1{font-size:22px;line-height:1.3;margin:0 0 8px}h2{font-size:17px;margin:0 0 12px}p{margin:0 0 16px}.muted{color:var(--color-text-secondary,light-dark(#555e6e,#b7c0cf));font-size:14px}.surface{border:1px solid var(--color-border-primary,light-dark(#dfe3e9,#3c4350));border-radius:12px;padding:18px;margin:16px 0}.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.path{overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:13px}.check{margin:8px 0}.check span{margin-right:8px}button,input{font:inherit}button{min-height:44px;padding:10px 16px;border:1px solid var(--color-border-primary,light-dark(#ccd2dc,#515b6e));border-radius:8px;cursor:pointer;color:inherit;background:transparent}button.primary{background:light-dark(#303d8f,#adbaff);color:light-dark(#fff,#10183c);border-color:transparent}button.text{border:0;text-decoration:underline;padding:8px}button:disabled{cursor:wait;opacity:.6}button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid light-dark(#6672cc,#aab8ff);outline-offset:3px}label{display:block;font-weight:600;margin:14px 0 6px}input[type=text]{width:100%;min-height:44px;border:1px solid var(--color-border-primary,light-dark(#bbc4d3,#596579));border-radius:8px;padding:10px;background:inherit;color:inherit}label.choice{font-weight:400;display:flex;gap:8px;align-items:center;min-height:44px;margin:0}input[type=checkbox]{width:18px;height:18px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}#status{margin:12px 0;overflow-wrap:anywhere}#status.error{color:light-dark(#a52429,#ffabb0)}[hidden]{display:none!important}summary{cursor:pointer;min-height:44px;display:flex;align-items:center;text-decoration:underline}@media(max-width:420px){body{padding:12px}.surface{padding:14px}.actions>*{width:100%}.row{align-items:flex-start}}
</style></head><body><main aria-busy="false">
<h1 id="title">Подключить Trelio к Codex</h1><p class="muted" id="company">Загрузка подключения…</p>
<div id="setup" hidden><div class="check"><span aria-hidden="true">✓</span>Вход в Trelio подтверждён</div><div class="check"><span aria-hidden="true">✓</span>Разрешение Codex проверено</div>
<section class="surface" aria-labelledby="folder-heading"><div class="row"><h2 id="folder-heading">Рабочая папка</h2><button class="text" id="modify" type="button" aria-controls="settings" aria-expanded="false">Изменить</button></div>
<p id="name"></p><p id="path" class="path"></p><p class="muted">Здесь будут файлы настройки и рабочие материалы Trelio</p>
<form id="settings" hidden><label for="display-name">Название подключения</label><input id="display-name" type="text" maxlength="200" required aria-describedby="name-help"><p class="muted" id="name-help">Сохраняется на этом компьютере. Проект в боковой панели Codex не создаётся</p>
<label for="folder-path">Локальная папка</label><input id="folder-path" type="text" maxlength="4096" required autocomplete="off" aria-describedby="path-help"><p class="muted" id="path-help">Отдельная постоянная папка для Trelio. Репозиторий с кодом не подойдёт</p>
<label class="choice"><input id="create" type="checkbox">Создать папку, если её ещё нет</label><div class="actions"><button id="pick" type="button">Выбрать существующую</button><button type="submit">Сохранить выбор</button></div></form></section>
<p class="muted">По кнопке «Подключить» сохраним в папке файлы AGENTS.md и CLAUDE.md и зарегистрируем путь в вашем аккаунте Trelio. Файлы настройки сохраняют существующий текст</p>
<div class="actions"><button id="connect" class="primary" type="button">Подключить</button></div></div>
<section class="surface" id="done" hidden><h2>Codex подключён</h2><p>Папка зарегистрирована в Trelio и проверена</p><p class="path" id="done-path"></p><p>Откройте задачу в Trelio и нажмите «Начать в Codex». При первом запуске выберите эту папку – Trelio запомнит выбор в этом браузере</p><div class="actions"><button class="primary" id="open" type="button">Открыть рабочую папку в Codex</button><button id="recheck" type="button">Проверить ещё раз</button></div></section>
<p id="status" role="status" aria-live="polite"></p>
</main><script>
(function(){'use strict';
var cap = '', state = null, busy = false, dirty = false, rpcId = 0, pending = new Map();
var $ = function(id) { return document.getElementById(id) };

// Only the parent host transports tool calls. No network API is available in
// the App. Match response IDs, reject unknown senders, and retain a longer
// human budget only for the existing protected encryption/unlock interaction.
function rpc(method, params) {
  var id = ++rpcId;
  return new Promise(function(resolve, reject) {
    var human = method === 'tools/call' && params.arguments.action === 'connect';
    var timer = setTimeout(function() {
      pending.delete(id); reject(new Error('HOST_TIMEOUT'));
    }, human ? 900000 : 60000);
    pending.set(id, {resolve: resolve, reject: reject, timer: timer});
    window.parent.postMessage({jsonrpc:'2.0', id:id, method:method, params:params || {}}, '*');
  });
}
function notice(text, error) {
  $('status').textContent = text;
  $('status').className = error ? 'error' : '';
  $('status').setAttribute('role', error ? 'alert' : 'status');
}
function fields() {
  return {folderPath:$('folder-path').value, displayName:$('display-name').value, createFolder:$('create').checked};
}
function resize() {
  window.parent.postMessage({jsonrpc:'2.0', method:'ui/notifications/size-changed',
    params:{height:document.documentElement.scrollHeight}}, '*');
}
function render(result) {
  var meta = result && result._meta && result._meta['trelio/codexConnection'];
  if (!meta) return;
  dirty = false; state = meta; cap = meta.capabilityToken;
  $('company').textContent = meta.companyName;
  $('name').textContent = meta.displayName;
  $('path').textContent = meta.folderPath;
  $('done-path').textContent = meta.folderPath;
  $('display-name').value = meta.displayName;
  $('folder-path').value = meta.folderPath;
  $('create').checked = meta.createFolder;
  var done = meta.stage === 'ready' && !result.isError;
  $('setup').hidden = done; $('done').hidden = !done;
  if (meta.errorCode) {
    var messages = {
      CODEX_CONNECTION_PICKER_UNAVAILABLE:'Окно выбора папки недоступно. Укажите абсолютный путь в поле «Локальная папка»',
      CODEX_CONNECTION_BINDING_CONFLICT:'Эта папка связана с другой компанией или проектом. Выберите отдельную папку',
      CODEX_CONNECTION_REGISTRATION_UNCONFIRMED:'Trelio пока не подтвердил регистрацию. Проверьте соединение и повторите проверку',
      CODEX_CONNECTION_READBACK_FAILED:'Не удалось подтвердить путь в Trelio. Повторите проверку',
      CODEX_CONNECTION_FOLDER_UNSAFE:'Папка содержит символическую ссылку. Выберите обычную локальную папку'
    };
    notice((messages[meta.errorCode] || 'Настройка не завершена. Проверьте папку, повторите проверку или передайте код ошибки агенту') + ' (' + meta.errorCode + ')', true);
  } else notice(done ? 'Подключение проверено' : '', false);
  resize();
}
function setBusy(value) {
  busy = value;
  document.querySelector('main').setAttribute('aria-busy', String(value));
  document.querySelectorAll('button,input').forEach(function(el) { el.disabled = value });
}
function unconfirmed(text) {
  // A timeout, expired card or host-level refusal must hide the previous ready
  // screen too. Retain the input so reopening/rechecking can reconcile it.
  $('done').hidden = true; $('setup').hidden = false; notice(text, true);
}
async function action(kind, settings) {
  if (busy || !cap) return;
  var requestCap = cap;
  setBusy(true);
  notice(kind === 'connect' ? 'Проверяем папку, сохраняем настройки и подтверждаем регистрацию в Trelio…' : 'Проверяем подключение…', false);
  try {
    var args = {capabilityToken:requestCap, action:kind};
    if (settings) args.settings = settings;
    var result = await rpc('tools/call', {name:'codex_connection_app_action', arguments:args});
    // A late response from a superseded card cannot restore an old connection.
    if (requestCap !== cap) return;
    render(result);
    if (result && result.isError && !result._meta) {
      unconfirmed('Проверка не завершена. Повторно откройте мастер через агента');
    }
  } catch (e) {
    if (requestCap === cap) unconfirmed('Нет ответа от Codex. Повторно откройте мастер в этом чате');
  } finally { setBusy(false); resize() }
}
$('modify').onclick = function() {
  var open = $('settings').hidden;
  $('settings').hidden = !open;
  $('modify').setAttribute('aria-expanded', String(open));
  if (open) $('display-name').focus();
  resize();
};
// Settings have one explicit local Save. Its pending/error lifecycle is the
// same as Connect; beforeunload protects only the unsaved local draft.
window.addEventListener('beforeunload', function(event) {
  if (dirty) { event.preventDefault(); event.returnValue = '' }
});
$('settings').oninput = function() { dirty = true };
$('settings').onsubmit = function(event) { event.preventDefault(); return action('save', fields()) };
$('pick').onclick = function() { return action('pick', fields()) };
$('connect').onclick = function() {
  if ($('settings').hidden || $('settings').reportValidity()) return action('connect', fields());
};
$('recheck').onclick = function() { return action('connect') };
$('open').onclick = async function() {
  if (state && state.openUrl) try { await rpc('ui/open-link', {url:state.openUrl}) }
  catch(e) { notice('Codex не открыл ссылку. Начните новую задачу в Trelio кнопкой «Начать в Codex»', true) }
};
window.addEventListener('message', function(event) {
  if (event.source !== window.parent) return;
  var m = event.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (m.id !== undefined && pending.has(m.id) && !m.method) {
    var p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(new Error('HOST_ERROR')); else p.resolve(m.result);
    return;
  }
  if (m.method === 'ui/notifications/tool-result') render(m.params);
});
rpc('ui/initialize', {appInfo:{name:'trelio-codex-connection', version:'1.0.0'},
  appCapabilities:{tools:{}}, protocolVersion:'2026-01-26'}).then(function() {
  window.parent.postMessage({jsonrpc:'2.0', method:'ui/notifications/initialized'}, '*'); resize();
}).catch(function() { notice('Этот клиент не открыл MCP App. Используйте ручную настройку в Trelio', true) });
})();
</script></body></html>`,
});
