/** Model-free servicing of the dedicated Windows Desktop, never a CLI updater.
 * The coordinator owns the idle lease and the host owns the setup mutex. This
 * module cannot choose a user, release URL, executable, credential or task. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ensurePrivateDirectory, assertPrivatePathKind } from './trelio-workspace.mjs';

const fail = () => { throw Object.assign(new Error(), { code:'ASSISTANT_CODEX_UPDATE_FAILED' }); };
const VERSION = /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){3}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const QUOTA = 1024*1024*1024;
export const CODEX_UPDATE_INTERVAL = 6*60*60_000;
// These architecture-specific URLs are published by OpenAI's Windows deployment
// documentation. No notification, task, model input or redirect chooses a feed.
export const CODEX_DESKTOP_DOWNLOADS = Object.freeze({
  x64:'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix',
  arm64:'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-arm64.msix',
});
export const compareCodexDesktopVersions = (left,right) => {
  if(!VERSION.test(left??'')||!VERSION.test(right??''))fail();
  const a=left.split('.').map(Number),b=right.split('.').map(Number);
  return a.reduce((result,value,index)=>result||Math.sign(value-b[index]),0);
};
export const validateAssistantCodexUpdate = value => {
  const keys=['schemaVersion','assistantId','deviceId','phase','checkedAt','etag','previousVersion','targetVersion','sha256','desktopGeneration','failedVersion'];
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!==keys.sort().join(',')
    ||value.schemaVersion!==1||!['ready','prepared','closing','installing','starting','verifying','failed'].includes(value.phase)
    ||!['assistantId','deviceId'].every(key=>/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value[key]??''))
    ||!Number.isSafeInteger(value.checkedAt)||value.checkedAt<0
    ||value.etag!==null&&(typeof value.etag!=='string'||!/^[\x20-\x7e]{1,256}$/u.test(value.etag))
    ||!VERSION.test(value.previousVersion??'')||!VERSION.test(value.targetVersion??'')
    ||value.failedVersion!==null&&!VERSION.test(value.failedVersion??'')
    ||value.phase==='failed'&&value.failedVersion===null
    ||value.sha256!==null&&!SHA.test(value.sha256??'')
    ||!['ready','failed'].includes(value.phase)&&value.sha256===null
    ||value.desktopGeneration!==null&&!/^[1-9]\d{0,9}:[0-9]{1,20}$/u.test(value.desktopGeneration??''))fail();
  return value;
};

/** Only code is downloaded. Keep it in the host's owner-private directory,
 * bound memory/disk, reject redirects/compression and publish only complete
 * bytes. A partial transfer cannot replace the previous inspected artifact. */
export const downloadCodexDesktop = async ({architecture,packagePath,etag=null,installedVersion=null,fetcher=fetch,signal}) => {
  const url=CODEX_DESKTOP_DOWNLOADS[architecture];
  if(!Object.hasOwn(CODEX_DESKTOP_DOWNLOADS,architecture)||!path.isAbsolute(packagePath??''))fail();
  const request=method=>fetcher(url,{method,redirect:'error',credentials:'omit',signal,headers:{'Accept-Encoding':'identity'}});
  const head=await request('HEAD');
  if(!head.ok||head.headers.get('content-encoding'))fail();
  const nextEtag=head.headers.get('etag');
  if(nextEtag!==null&&!/^[\x20-\x7e]{1,256}$/u.test(nextEtag))fail();
  if(etag!==null&&nextEtag===etag)return {unchanged:true,etag};
  // The official blob currently approaches 1 GiB. Its public version hint may
  // suppress an unnecessary download, but can NEVER authorize deployment: a
  // newer hint still requires the complete signed MSIX/manifest/native checks.
  const hint=head.headers.get('x-ms-meta-package_version');
  if(VERSION.test(installedVersion??'')&&VERSION.test(hint??'')
    &&head.headers.get('x-ms-meta-package_identity')==='OpenAI.Codex'
    &&head.headers.get('x-ms-meta-architecture')===architecture
    &&compareCodexDesktopVersions(hint,installedVersion)<=0)return {unchanged:true,etag:nextEtag};
  const response=await request('GET');
  if(!response.ok||!response.body||response.headers.get('content-encoding'))fail();
  const length=Number(response.headers.get('content-length'));
  if(!Number.isSafeInteger(length)||length<1024||length>QUOTA)fail();
  const receivedEtag=response.headers.get('etag');
  if(nextEtag!==null&&receivedEtag!==nextEtag)fail();
  await ensurePrivateDirectory(path.dirname(packagePath));
  const partial=packagePath+'.partial';
  for(const candidate of [packagePath,partial]){
    try{await assertPrivatePathKind(candidate,'file');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  // This is an uncommitted code download, under the single idle/setup lock.
  // An interrupted installer never enters this path; its journal permits only
  // native read-back, so deleting an old partial cannot replay deployment.
  await fs.unlink(partial).catch(error=>{if(error.code!=='ENOENT')throw error;});
  const handle=await fs.open(partial,'wx',0o600),hash=createHash('sha256');let total=0;
  try{
    for await(const chunk of response.body){
      signal?.throwIfAborted();total+=chunk.byteLength;if(total>length)fail();
      hash.update(chunk);await handle.writeFile(chunk);
    }
    if(total!==length)fail();await handle.sync();
  }catch(error){await handle.close();await fs.unlink(partial).catch(()=>undefined);throw error;}
  await handle.close();await assertPrivatePathKind(partial,'file');
  await fs.rename(partial,packagePath);await assertPrivatePathKind(packagePath,'file');
  return {unchanged:false,etag:nextEtag,sha256:hash.digest('hex')};
};

/** Fixed OS-module helper, carried by the signed runtime. The entire MSIX is
 * authenticated BEFORE Desktop is closed; Windows revalidates at deployment.
 * Hold a read-only, no-write/no-delete file handle across hash/signature/read/
 * deployment to prevent a package swap between inspection and installation.
 * There are deliberately no force, unsigned, downgrade, elevation or user-wide
 * provisioning options. In-use packages defer registration instead of killing
 * a process, even if an external application raced the final idle check. */
export const ASSISTANT_CODEX_UPDATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
try {
  Microsoft.PowerShell.Core\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
  Microsoft.PowerShell.Core\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules\Appx\Appx.psd1')) -ErrorAction Stop
  $p = ConvertFrom-Json ([Console]::In.ReadToEnd())
  if ($p.operation -notin @('inspect','prepare','install')) { throw 'invalid' }
  $packages = @(Appx\Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop)
  if ($p.operation -eq 'inspect' -and $packages.Count -eq 0) {
    [Console]::Out.Write('{"schemaVersion":1,"state":"not_installed"}'); exit 0
  }
  if ($packages.Count -ne 1 -or $packages[0].PackageFamilyName -cne 'OpenAI.Codex_2p2nqsd0c76g0') { throw 'identity' }
  $installed = $packages[0]
  $architecture = ([string]$installed.Architecture).ToLowerInvariant()
  if ($architecture -notin @('x64','arm64')) { throw 'architecture' }
  if ($p.operation -eq 'inspect') {
    [Console]::Out.Write((ConvertTo-Json -Compress @{schemaVersion=1;version=[string]$installed.Version;architecture=$architecture})); exit 0
  }
  if ($p.sha256 -cnotmatch '^[a-f0-9]{64}$' -or ![IO.Path]::IsPathRooted([string]$p.packagePath)) { throw 'invalid' }
  Microsoft.PowerShell.Core\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop
  $file = [IO.File]::Open([string]$p.packagePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($hash.ComputeHash($file))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
    if ($digest -cne $p.sha256) { throw 'digest' }
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath ([string]$p.packagePath) -ErrorAction Stop
    if ($signature.Status -ne 'Valid') { throw 'signature' }
    # MSIX Store signatures can be Microsoft signatures. Bind the application
    # identity to the current registered publisher, not a guessed cert subject.
    [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression')
    $file.Position = 0
    $zip = [IO.Compression.ZipArchive]::new($file,[IO.Compression.ZipArchiveMode]::Read,$true)
    try {
      $entries = @($zip.Entries | Where-Object { $_.FullName -ceq 'AppxManifest.xml' })
      if ($entries.Count -ne 1 -or $entries[0].Length -gt 1048576) { throw 'manifest' }
      $settings = [Xml.XmlReaderSettings]::new(); $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit; $settings.XmlResolver = $null
      $stream = $entries[0].Open(); $reader = [Xml.XmlReader]::Create($stream,$settings)
      try { $xml = [Xml.XmlDocument]::new(); $xml.XmlResolver = $null; $xml.Load($reader) } finally { $reader.Dispose(); $stream.Dispose() }
      $identity = $xml.Package.Identity
      if ($identity.Name -cne 'OpenAI.Codex' -or $identity.Publisher -cne $installed.Publisher -or $identity.ProcessorArchitecture -cne $architecture) { throw 'identity' }
      $version = [Version]([string]$identity.Version)
      if ($p.operation -eq 'install' -and $version -le $installed.Version) { throw 'version' }
    } finally { $zip.Dispose() }
    if ($p.operation -eq 'install') {
      if ([string]$version -cne $p.version) { throw 'version' }
      Appx\Add-AppxPackage -Path ([string]$p.packagePath) -DeferRegistrationWhenPackagesAreInUse -ErrorAction Stop
    }
    [Console]::Out.Write((ConvertTo-Json -Compress @{schemaVersion=1;version=[string]$version;architecture=$architecture}))
  } finally { $file.Dispose() }
} catch { [Console]::Out.Write('{"schemaVersion":1,"state":"unavailable"}'); exit 1 }
`;

export const runAssistantWindowsCodexUpdate = async (operation,{environment=process.env,signal,packagePath,sha256,version,guard=async()=>{},runNative}={}) => {
  if(!['inspect','prepare','install'].includes(operation)||operation!=='inspect'&&(!path.win32.isAbsolute(packagePath??'')||!SHA.test(sha256??''))
    ||operation==='install'&&!VERSION.test(version??''))fail();
  if(operation!=='inspect')await assertPrivatePathKind(packagePath,'file');
  await guard();
  const run=runNative??(await import('./trelio-assistant-setup.mjs')).runAssistantWindowsBackgroundNative;
  return run({operation,...(operation==='inspect'?{}:{packagePath,sha256,...(operation==='install'?{version}:{})})},
    {environment,signal,timeoutMs:operation==='inspect'?40_000:5*60_000,script:ASSISTANT_CODEX_UPDATE_SCRIPT,project:value=>{
      if(operation==='inspect'&&value?.schemaVersion===1&&value.state==='not_installed'
        &&Object.keys(value).sort().join(',')==='schemaVersion,state')return value;
      if(!value||Object.keys(value).sort().join(',')!=='architecture,schemaVersion,version'||value.schemaVersion!==1
        ||!VERSION.test(value.version??'')||!Object.hasOwn(CODEX_DESKTOP_DOWNLOADS,value.architecture))fail();
      return value;
    }});
};

/** A single install intent is never replayed. After interruption, inspect the
 * native package and GUI, resume the same visible Desktop, then check hooks/MCP.
 * Original task chats, private state, schedules, files and credentials have no
 * write path here. A failed candidate is latched until a newer signed version. */
export const maintainAssistantCodexDesktop = async ({identity,readState,writeState,inspect,download,prepare,install,desktop,probe,guard=async()=>{},now=Date.now}) => {
  await guard();let state=await readState(),preparedThisTick=false;
  const save=async patch=>{
    await guard();const next=validateAssistantCodexUpdate({...state,...patch});
    await writeState(state,next);state=next;
  };
  const current=await inspect();
  if(current.state==='not_installed'){
    if(state&&!['ready','failed'].includes(state.phase))fail();
    return {state:'not_installed'};
  }
  if(!state)await save({schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,phase:'ready',checkedAt:0,etag:null,
    previousVersion:current.version,targetVersion:current.version,sha256:null,desktopGeneration:null,failedVersion:null});
  if(state.phase==='failed'&&compareCodexDesktopVersions(current.version,state.failedVersion)>=0){
    // Windows may finish a deferred registration after an earlier old-version
    // read-back, or the human may complete recovery. Exact native version AND
    // a fresh running GUI/probe can release the failure; an ETag never can.
    const app=await desktop('inspect');
    if(app.state==='running'&&app.generation!==state.desktopGeneration){
      await guard();await probe();
      await save({phase:'ready',targetVersion:current.version,desktopGeneration:app.generation,failedVersion:null,checkedAt:now()});
      return {state:'updated',version:current.version};
    }
  }
  if(['ready','failed'].includes(state.phase)){
    if(now()-state.checkedAt<CODEX_UPDATE_INTERVAL)return {state:'current',failedVersion:state.failedVersion};
    // Discovery and code verification are optional until the intent is saved.
    // An offline feed or an invalid candidate cannot stop the healthy old app.
    try{
      const candidate=await download(current.architecture,state.etag,current.version);
      if(candidate.unchanged){await save({checkedAt:now(),etag:candidate.etag});return {state:'current',failedVersion:state.failedVersion};}
      // Inspect only after the complete artifact is durably downloaded.
      const target=await prepare(candidate.sha256);
      if(compareCodexDesktopVersions(target.version,current.version)<=0
        ||state.failedVersion&&compareCodexDesktopVersions(target.version,state.failedVersion)<=0){
        await save({checkedAt:now(),etag:candidate.etag});return {state:'current',failedVersion:state.failedVersion};
      }
      await save({phase:'prepared',checkedAt:now(),etag:candidate.etag,previousVersion:current.version,
        targetVersion:target.version,sha256:candidate.sha256,desktopGeneration:null,failedVersion:null});
      preparedThisTick=true;
    }catch(error){await guard();if(state.phase!=='ready'&&state.phase!=='failed')throw error;
      await save({checkedAt:now()});return {state:'current',updateDeferred:true,failedVersion:state.failedVersion};}
  }
  if(state.phase==='prepared'){
    // A resumed preparation must authenticate its retained file again BEFORE
    // the GUI effect. The same invocation already did this during discovery.
    if(!preparedThisTick){
      const target=await prepare(state.sha256);
      if(target.version!==state.targetVersion||target.architecture!==current.architecture)fail();
    }
    const app=await desktop('inspect');
    // Persist the exact process generation before one graceful shutdown.
    // A refused exit is observed, never repeated or forced. The separate
    // activation grace later raises an incident without changing that intent.
    await save({phase:'closing',desktopGeneration:app.generation});
    if(app.state==='running'){await guard();await desktop('close',app.generation);}
  }
  if(state.phase==='closing'){
    const app=await desktop('inspect');
    if(app.state!=='stopped'){
      if(now()-state.checkedAt>=10*60_000)fail();
      return {state:'activating',blockBusiness:true};
    }
    // Retain the installed version from BEFORE the effect. A native reply or
    // a process exit alone never supplies permission for another installation.
    await save({phase:'installing'});await guard();
    await install(state.sha256,state.targetVersion);
    await save({phase:'starting'});
  }else if(state.phase==='installing'){
    // Recovered unknown install: read-only observation, then re-open Desktop.
    // Even an unchanged package is not evidence that deployment never began.
    await save({phase:'starting'});
  }
  if(state.phase==='starting'){
    const app=await desktop('inspect');
    await save({phase:'verifying'});
    if(app.state==='stopped'){await guard();await desktop('start');}
  }
  if(state.phase==='verifying'){
    const app=await desktop('inspect');
    if(app.state!=='running'||app.generation===state.desktopGeneration){
      if(now()-state.checkedAt>=10*60_000)fail();
      return {state:'activating',blockBusiness:true};
    }
    const actual=await inspect();
    try{await probe();}catch(error){if(error.code==='ASSISTANT_HOOK_REVIEW_REQUIRED')return {state:'hook_review',blockBusiness:true};throw error;}
    if(compareCodexDesktopVersions(actual.version,state.targetVersion)<0){
      // A lost/failed deployment may leave the known-good app intact. Once its
      // fresh native probe passes, preserve normal work but report the failure.
      await save({phase:'failed',failedVersion:state.targetVersion});
      return {state:'failed',failedVersion:state.targetVersion};
    }
    await save({phase:'ready',targetVersion:actual.version,desktopGeneration:app.generation,failedVersion:null});
    return {state:'updated',version:actual.version};
  }
  fail();
};
