/** Optional Run metadata maintenance. No model turn or local chat inventory. */
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
