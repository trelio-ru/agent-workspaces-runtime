/** Model-visible setup composes the existing protected S256/device client.
 * Only structural receipts leave this boundary; raw verifier/credential stays
 * inside the common OS-backed store and fixed HTTPS transport. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveHostRuntimeLoader } from './trelio-host-runtime-recovery.mjs';
import { createAssistantPairingClient, createAssistantDeviceClient } from './trelio-assistant-transport.mjs';
import { validateAssistantActivationAuthorization } from './trelio-assistant-hook.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export class AssistantSetupError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AssistantSetupError(code); };
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('ASSISTANT_SETUP_INVALID_INPUT'); return value.toLowerCase(); };
export const createAssistantSetup = ({ origin, store, http, host, withLock = action => action(),
  backgroundReplacement, now = Date.now }) => {
  if(!host?.readIdentity || !host?.prepareActivation || !host?.commitActivation) fail('ASSISTANT_SETUP_INVALID_INPUT');
  const pairing = createAssistantPairingClient({ origin, store, http, now });
  const key = enrollmentId => ({ origin, kind: 'pairing', id: id(enrollmentId) });
  const identity = record => ({schemaVersion:1,origin,assistantId:id(record.assistantId),deviceId:id(record.deviceId)});
  const same = (left,right) => JSON.stringify(left)===JSON.stringify(right);
  const deviceSlot = assistantId => ({origin,kind:'device',id:assistantId});
  const releasePending = async enrollmentId => {
    // Releasing a pending-only denial grants no device/business authority.
    // Definitive native rejection + exact unchanged protected host + no local
    // pass suffice even when the OLD credential is already broken/revoked.
    // Requiring its heartbeat would permanently trap this repair workflow.
    await host.releaseSetupIntent(enrollmentId);
  };
  const observePairing = async (enrollmentId,action) => {
    try{
      const result=await action();
      if(result.state==='denied')await releasePending(enrollmentId);
      return result;
    }catch(error){
      // Only a definitive native rejection releases a pending-only denial.
      // 409, network failure, local expiry or missing/mismatched old credential
      // cannot establish that the owner did not already approve replacement.
      if(error.code==='ASSISTANT_PAIRING_EXPIRED'&&error.status===410)await releasePending(enrollmentId);
      throw error;
    }
  };
  const guardLocalPass = async enrollmentId => {
    const current=await host.readIdentity();
    if(current!==null){
      if(await host.readActivePass()!==null)fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      await host.prepareSetupIntent(enrollmentId);
    }
  };
  const validSecret = value => value && UUID.test(value.assistantId??'') && UUID.test(value.deviceId??'')
    && /^tda_[A-Za-z0-9_-]{43}$/u.test(value.credential??'') && Number.isSafeInteger(value.expiresAt) && value.expiresAt>0;
  const candidateClient = record => {
    if(!validSecret(record))fail('ASSISTANT_SETUP_RECOVERY_REQUIRED');
    const secret=Object.fromEntries(['assistantId','deviceId','credential','expiresAt'].map(name=>[name,record[name]]));
    // A candidate heartbeat uses its own protected staged value. It never
    // publishes that value into the currently active assistant credential slot.
    const candidateStore={get:async input=>same(input,deviceSlot(record.assistantId))?secret:store.get(input)};
    return createAssistantDeviceClient({...identity(record),store:candidateStore,http});
  };
  const paired = async record => {
    if(record.origin!==origin)fail('ASSISTANT_SETUP_RECOVERY_REQUIRED');
    const next=identity(record),old=await host.readIdentity();
    if(old!==null&&!same(old,next))return {state:'replacement_required',code:'ASSISTANT_HOST_REBIND_REQUIRED',businessReady:false};
    await createAssistantDeviceClient({...next,store,http}).heartbeat();
    if(old===null)await host.saveIdentity(next);
    return {state:'paired',assistantId:next.assistantId,deviceId:next.deviceId,businessReady:false,
      requiredCapabilities:['task_pass_admission','background_service']};
  };
  const waiting = (reason,manual=false,previous=null) => ({state:'replacement_waiting_background',reason,businessReady:false,
    requiredAction:reason==='unresolved_pass'?'reconcile_original_pass':manual?'stop_exact_idle_supervisor_then_finish':'finish_assistant_setup',
    ...(manual&&previous?{backgroundTaskName:'Trelio-DigitalAssistant-'+previous.assistantId,
      instruction:'The old supervisor has been fenced from starting new work and no protected pass is active. If it cannot exit itself, stop only Windows Task Scheduler task Trelio-DigitalAssistant-'+previous.assistantId+'; do not delete identity, credentials, journals or accounts. Then finish the SAME enrollment again.'}:{})});
  const activate = async (enrollmentId,record,mutate) => {
    if(record.origin!==origin||!['candidate','activating'].includes(record.phase)||!validSecret(record))fail('ASSISTANT_SETUP_RECOVERY_REQUIRED');
    const next=identity(record),authorization=validateAssistantActivationAuthorization(record.activation);
    const previous=record.hostIdentity===null?null:{schemaVersion:1,origin,
      assistantId:id(record.hostIdentity?.assistantUserId),deviceId:id(record.hostIdentity?.deviceId)};
    const live=await candidateClient(record).heartbeat();
    // Old generic pairing approval never becomes replacement authority. The
    // live native candidate must still expose this exact NEW owner receipt.
    if(authorization.mode==='replace'&&!same(live.activation,authorization))fail('ASSISTANT_HOST_REBIND_REQUIRED');
    if(!mutate)return {state:'activation_pending',businessReady:false,requiredAction:'finish_assistant_setup'};
    const activation=await host.prepareActivation({enrollmentId,previous,next,authorization});
    if(activation.stage==='quiescing'){
      try{await host.assertActivationQuiescent(activation);}
      catch(error){if(error.code==='ASSISTANT_PASS_REVIEW_REQUIRED')return waiting('unresolved_pass');throw error;}
      const identityAlreadyWritten=same(await host.readIdentity(),next);
      if(identityAlreadyWritten&&record.backgroundSettled!==true)fail('ASSISTANT_SETUP_ACTIVATION_RECOVERY_REQUIRED');
      if(previous!==null&&!identityAlreadyWritten){
        if(!backgroundReplacement)fail('ASSISTANT_BACKGROUND_UNAVAILABLE');
        const observed=await backgroundReplacement.inspect(previous);
        if(observed.state==='running'||observed.state==='queued')return waiting('supervisor_not_idle',true,previous);
        if(observed.state!=='not_installed'){
          if(!record.backgroundSnapshot){
            record={...record,backgroundSnapshot:observed.snapshot};await store.put(key(enrollmentId),record);
          }
          if(!same(record.backgroundSnapshot,observed.snapshot))fail('ASSISTANT_BACKGROUND_CONFLICT');
          if(record.backgroundRemoval==='attempted')return waiting('removal_outcome_unknown');
          record={...record,backgroundRemoval:'attempted'};await store.put(key(enrollmentId),record);
          try{await backgroundReplacement.remove(previous,record.backgroundSnapshot);}
          catch(error){
            if(error.code!=='ASSISTANT_BACKGROUND_BUSY')throw error;
            // The native helper proves this exact refusal precedes DeleteTask
            // (for example logon raced the idle snapshot). Release only this
            // known-no-delete attempt; a later explicit finish must still
            // reread the SAME snapshot. Unknown/access failures stay fenced.
            const {backgroundRemoval,...unattempted}=record;record=unattempted;
            await store.put(key(enrollmentId),record);return waiting('supervisor_not_idle',true,previous);
          }
          if((await backgroundReplacement.inspect(previous)).state!=='not_installed')fail('ASSISTANT_BACKGROUND_READBACK_FAILED');
        }
      }
      if(record.backgroundSettled!==true){record={...record,backgroundSettled:true};await store.put(key(enrollmentId),record);}
      await host.assertActivationQuiescent(activation);
      if(authorization.mode==='replace'&&!same((await candidateClient(record).heartbeat()).activation,authorization))
        fail('ASSISTANT_HOST_REBIND_REQUIRED');
      const active=await store.get(deviceSlot(next.assistantId));
      const secret=Object.fromEntries(['assistantId','deviceId','credential','expiresAt'].map(name=>[name,record[name]]));
      if(!same(active,secret)){
        if(record.activeCredentialWrite==='attempted')fail('ASSISTANT_SETUP_ACTIVATION_RECOVERY_REQUIRED');
        if(active!==null&&(!validSecret(active)||previous===null||active.assistantId!==previous.assistantId||active.deviceId!==previous.deviceId))
          fail('ASSISTANT_HOST_REBIND_REQUIRED');
        // Keep the old protected slot in the SAME enrollment journal until
        // activation read-back. A failed/unknown writer never triggers exchange
        // replay or a second credential write; the next call reads it back.
        record={...record,phase:'activating',activeCredentialWrite:'attempted',previousCredential:active};
        await store.put(key(enrollmentId),record);
        await store.put(deviceSlot(next.assistantId),secret);
      }
      await host.commitActivation(activation);
    }
    const complete={phase:'complete',origin,assistantId:next.assistantId,deviceId:next.deviceId};
    await store.put(key(enrollmentId),complete);
    return paired(complete);
  };
  const statusUnlocked=async(enrollmentId,mutate=false)=>{
    const record=await store.get(key(enrollmentId));
    if(!record)return {state:'not_started'};
    if(record.phase==='complete')return paired(record);
    if(['candidate','activating'].includes(record.phase))return activate(enrollmentId,record,mutate);
    if(record.phase==='exchanging')return {state:'recovery_required'};
    if(['prepared','pending'].includes(record.phase)&&record.recovery&&UUID.test(record.pairingId??'')){
      // A persisted explicit replacement survives the short code/enrollment
      // TTL. Read the candidate's durable native receipt BEFORE refreshing the
      // expirable pairing; this path never invokes a one-use exchange.
      const recovered=await pairing.exchange(enrollmentId);
      if(recovered.state==='candidate')return activate(enrollmentId,await store.get(key(enrollmentId)),mutate);
    }
    if(record.phase==='prepared'){
      const result=await observePairing(enrollmentId,()=>pairing.refresh(enrollmentId));
      return {state:result.state==='denied'?'denied':'waiting_owner',verificationCode:result.verificationCode,expiresAt:result.expiresAt};
    }
    if(record.phase!=='pending'||!Number.isSafeInteger(record.expiresAt)||!/^[A-F0-9]{8}$/u.test(record.verificationCode??''))
      fail('ASSISTANT_SETUP_RECOVERY_REQUIRED');
    const result=await observePairing(enrollmentId,()=>pairing.refresh(enrollmentId));
    return {state:result.state==='denied'?'denied':'waiting_owner',verificationCode:result.verificationCode,expiresAt:result.expiresAt};
  };
  return {
    status:enrollmentId=>withLock(()=>statusUnlocked(id(enrollmentId))),
    begin:(enrollmentId,deviceName)=>withLock(async()=>{
      enrollmentId=id(enrollmentId);
      const record=await store.get(key(enrollmentId));
      if(record?.phase==='complete'||['candidate','activating'].includes(record?.phase))return statusUnlocked(enrollmentId);
      await guardLocalPass(enrollmentId);
      const current=await host.readIdentity();
      const hostIdentity=current===null?null:{assistantUserId:current.assistantId,deviceId:current.deviceId};
      // The only legacy candidate we can locate without scanning private slots
      // is a different device already saved at this host assistant's exact key.
      // Its bearer remains inside the protected transport and authorizes no
      // replacement until a NEW explicit owner decision is persisted natively.
      const saved=current===null?null:await store.get(deviceSlot(current.assistantId));
      const recoveryCandidate=validSecret(saved)&&saved.assistantId===current?.assistantId&&saved.deviceId!==current?.deviceId?saved:null;
      const result=await observePairing(enrollmentId,()=>pairing.begin(enrollmentId,deviceName,{hostIdentity,recoveryCandidate}));
      return {state:result.state==='denied'?'denied':'waiting_owner',verificationCode:result.verificationCode,expiresAt:result.expiresAt};
    }),
    finish:enrollmentId=>withLock(async()=>{
      enrollmentId=id(enrollmentId);const record=await store.get(key(enrollmentId));
      if(record?.phase==='complete'||['candidate','activating'].includes(record?.phase))return statusUnlocked(enrollmentId,true);
      if(!record||!['prepared','pending'].includes(record.phase))fail('ASSISTANT_PAIRING_RECOVERY_REQUIRED');
      await guardLocalPass(enrollmentId);
      if(!record.recovery){
        const observed=await observePairing(enrollmentId,()=>pairing.refresh(enrollmentId));
        if(observed.state==='denied')return {state:'denied'};
      }
      const result=await pairing.exchange(enrollmentId);
      if(result.state==='pending')return {state:'waiting_owner'};
      return statusUnlocked(enrollmentId,true);
    }),
  };
};

/** Per-user Windows Task Scheduler registration for the signed supervisor.
 * This is not a Windows service, automatic logon, Codex restart or readiness
 * assertion. The existing interactive user owns DPAPI, provider sessions and
 * Codex authentication; a different principal must never inherit them.
 */

const operations = new Set(['install', 'status', 'start', 'remove']);
const codes = new Set(['ASSISTANT_BACKGROUND_UNAVAILABLE', 'ASSISTANT_BACKGROUND_CONFLICT',
  'ASSISTANT_BACKGROUND_BUSY', 'ASSISTANT_BACKGROUND_NOT_INSTALLED', 'ASSISTANT_BACKGROUND_READBACK_FAILED', 'ASSISTANT_BACKGROUND_ACCESS_DENIED']);
const windowsPath = value => typeof value === 'string' && value.length <= 4096
  && /^[a-z]:\\/iu.test(value) && !/[\x00-\x1f\x7f"]/u.test(value);
// Task Scheduler passes an Exec action to CreateProcess, not to cmd.exe. Quote
// with the Windows argv rules, including trailing slashes; never build a shell
// command or interpolate a selected path into PowerShell source.
export const quoteAssistantWindowsArgument = value => '"' + value.replace(/(\\*)"/gu, '$1$1\\"')
  .replace(/(\\+)$/u, '$1$1') + '"';

/** Constant source only. All variable values travel as bounded UTF-8 JSON on
 * stdin. Task Scheduler/WindowsIdentity here inspect PUBLIC OS registration,
 * never ACL, DPAPI, a credential or the private worker protocol. PowerShell is
 * process-scoped, noninteractive and profile-free; no policy is saved.
 *
 * COM gives exact task definitions and HRESULTs independently of OS display
 * language. A different definition at our deterministic name is a conflict,
 * not permission to overwrite another task using Register -Force.
 */
export const ASSISTANT_WINDOWS_BACKGROUND_SCRIPT = String.raw`
[Console]::Error.WriteLine('TRELIO_TASK_STAGE script')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
[Console]::Error.WriteLine('TRELIO_TASK_STAGE encoding')
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  # Closed diagnostic stages only. The ordinary parent discards stderr; the
  # hosted native fixture may observe these enums to distinguish cold process
  # startup, encoding/module loading, input EOF and Task Scheduler COM timeouts
  # without OS/user data. Command discovery for the first unqualified New-Object
  # took 22-35 seconds on hosted ARM64, while this script entered in <0.3s.
  # Import only the OS utility module by its fixed PSHOME manifest. Do not scan
  # installed/user modules, extend the native deadline or change machine policy.
  [Console]::Error.WriteLine('TRELIO_TASK_STAGE module')
  Microsoft.PowerShell.Core\Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
  [Console]::Error.WriteLine('TRELIO_TASK_STAGE input')
  $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [Console]::Error.WriteLine('TRELIO_TASK_STAGE identity')
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($sid -notmatch '^S-1-(5-21|12-1)-[0-9-]+$') { throw 'ASSISTANT_BACKGROUND_UNAVAILABLE' }
  [Console]::Error.WriteLine('TRELIO_TASK_STAGE scheduler')
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  [Console]::Error.WriteLine('TRELIO_TASK_STAGE folder')
  $folder = $service.GetFolder('\')
  $name = 'Trelio-DigitalAssistant-' + $p.assistantId
  $marker = 'Trelio digital assistant background v1 ' + $p.assistantId + '/' + $p.deviceId
  $existing = $null
  function Test-NotFound($failure) {
    $cause = $failure.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    return $cause.HResult -eq -2147024894
  }
  [Console]::Error.WriteLine('TRELIO_TASK_STAGE lookup')
  try { $existing = $folder.GetTask($name) } catch {
    if (!(Test-NotFound $_)) { throw }
  }
  function Resolve-PrincipalSid([string]$value) {
    # Task Scheduler normalizes a submitted SID to an account name on read.
    # Resolve it with the native account API and compare the immutable SID;
    # never accept a display-name/string match or a different domain account.
    try {
      if ($value -match '^S-1-[0-9-]+$') { return ([System.Security.Principal.SecurityIdentifier]::new($value)).Value }
      return ([System.Security.Principal.NTAccount]::new($value)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch { return '' }
  }
  function Test-Definition($task) {
    $d = $task.Definition
    $checks = @{
      marker = $d.RegistrationInfo.Description -ceq $marker
      principal = (Resolve-PrincipalSid $d.Principal.UserId) -ceq $sid
      logon = $d.Principal.LogonType -eq 3 -and $d.Principal.RunLevel -eq 0
      action_count = $d.Actions.Count -eq 1
      action_type = $d.Actions.Item(1).Type -eq 0
      action_path = $d.Actions.Item(1).Path -ceq $p.command
      action_arguments = $d.Actions.Item(1).Arguments -ceq $p.arguments
      action_cwd = $d.Actions.Item(1).WorkingDirectory -ceq $p.workingDirectory
      trigger_count = $d.Triggers.Count -eq 1
      trigger_type = $d.Triggers.Item(1).Type -eq 9
      trigger_user = (Resolve-PrincipalSid $d.Triggers.Item(1).UserId) -ceq $sid
      trigger_enabled = [bool]$d.Triggers.Item(1).Enabled
      trigger_delay = $d.Triggers.Item(1).Delay -ceq 'PT15S'
      enabled = [bool]$d.Settings.Enabled
      instances = $d.Settings.MultipleInstances -eq 2
      duration = $d.Settings.ExecutionTimeLimit -ceq 'PT0S'
      demand = [bool]$d.Settings.AllowDemandStart
      available = [bool]$d.Settings.StartWhenAvailable
      battery_start = !$d.Settings.DisallowStartIfOnBatteries
      battery_stop = !$d.Settings.StopIfGoingOnBatteries
      restarts = $d.Settings.RestartCount -eq 3
      restart_interval = $d.Settings.RestartInterval -ceq 'PT1M'
    }
    $failed = @($checks.Keys | Where-Object { !$checks[$_] })
    # Diagnostic field names only, never an OS value/path/SID/definition. The
    # production parent ignores stderr; the hosted fixture reads this allowlist.
    foreach ($key in $failed) { [Console]::Error.WriteLine('TRELIO_TASK_CHECK ' + $key) }
    return $failed.Count -eq 0
  }
  # Replacement is an internal, owner-approved pairing path, never a normal
  # installer option. An older plugin path may no longer exist; inspect its
  # PUBLIC definition without resolving, reading or executing that path. The
  # exact old identity marker, current SID and ordinary least-privilege policy
  # still have to match. The full XML digest fences every otherwise unprojected
  # field across the later idle deletion.
  $replacement = $p.operation -eq 'replacement_inspect' -or $p.operation -eq 'replacement_remove'
  if ($replacement) {
    function Test-DefinitionForReplacement($task) {
      if ($task.Definition.Actions.Count -ne 1) { return $false }
      $action = $task.Definition.Actions.Item(1)
      $savedCommand = $p.command
      $savedArguments = $p.arguments
      $savedCwd = $p.workingDirectory
      if ($action.Path -notmatch '^[a-zA-Z]:\\(?:[^\r\n\x00"]+\\)?node\.exe$' -or
          $action.Arguments -cnotmatch '^"[a-zA-Z]:\\(?:[^\r\n\x00"]+\\)?trelio-host-runtime-loader\.mjs" bridge assistant background$' -or
          $action.WorkingDirectory -cne [System.IO.Path]::GetDirectoryName($action.Path)) { return $false }
      $p.command = $action.Path
      $p.arguments = $action.Arguments
      $p.workingDirectory = $action.WorkingDirectory
      try { return (Test-Definition $task) }
      finally {
        $p.command = $savedCommand
        $p.arguments = $savedArguments
        $p.workingDirectory = $savedCwd
      }
    }
    if ($existing -and !(Test-DefinitionForReplacement $existing)) { throw 'ASSISTANT_BACKGROUND_CONFLICT' }
    function Get-DefinitionHash($task) {
      $hasher = [System.Security.Cryptography.SHA256]::Create()
      try { return ([System.BitConverter]::ToString($hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($task.Xml)))).Replace('-', '').ToLowerInvariant() }
      finally { $hasher.Dispose() }
    }
    if ($p.operation -eq 'replacement_remove') {
      # A lost delete response can be reconciled as absent. An existing task
      # must match the protected original snapshot, not just a familiar name.
      if ($existing) {
        if (!$p.snapshot -or $p.snapshot.principalSid -cne $sid -or $p.snapshot.definitionSha256 -cne (Get-DefinitionHash $existing)) { throw 'ASSISTANT_BACKGROUND_CONFLICT' }
        if ($existing.State -eq 4 -or $existing.State -eq 2) { throw 'ASSISTANT_BACKGROUND_BUSY' }
        # Reopen immediately before the single mutation: a changed definition
        # or queued/logon instance must never be removed using an old snapshot.
        $existing = $folder.GetTask($name)
        if (!(Test-DefinitionForReplacement $existing)) { throw 'ASSISTANT_BACKGROUND_CONFLICT' }
        if ($p.snapshot.definitionSha256 -cne (Get-DefinitionHash $existing)) { throw 'ASSISTANT_BACKGROUND_CONFLICT' }
        if ($existing.State -eq 4 -or $existing.State -eq 2) { throw 'ASSISTANT_BACKGROUND_BUSY' }
        $folder.DeleteTask($name, 0)
        try { $null = $folder.GetTask($name); throw 'ASSISTANT_BACKGROUND_READBACK_FAILED' } catch { if (!(Test-NotFound $_)) { throw } }
        $existing = $null
      }
    }
    $snapshot = $null
    $state = 'not_installed'
    if ($existing) {
      $snapshot = @{schemaVersion=1;assistantId=$p.assistantId;deviceId=$p.deviceId;principalSid=$sid;definitionSha256=(Get-DefinitionHash $existing)}
      $state = 'registered'
      if ($existing.State -eq 4) { $state = 'running' }
      if ($existing.State -eq 2) { $state = 'queued' }
    }
    [Console]::Out.WriteLine((@{schemaVersion=1;state=$state;snapshot=$snapshot} | ConvertTo-Json -Depth 3 -Compress))
    return
  }
  if ($existing -and !(Test-Definition $existing)) { throw 'ASSISTANT_BACKGROUND_CONFLICT' }
  if ($p.operation -eq 'install' -and !$existing) {
    $d = $service.NewTask(0)
    $d.RegistrationInfo.Description = $marker
    $d.Principal.UserId = $sid
    $d.Principal.LogonType = 3
    $d.Principal.RunLevel = 0
    $d.Settings.Enabled = $true
    $d.Settings.MultipleInstances = 2
    $d.Settings.ExecutionTimeLimit = 'PT0S'
    $d.Settings.AllowDemandStart = $true
    $d.Settings.StartWhenAvailable = $true
    $d.Settings.DisallowStartIfOnBatteries = $false
    $d.Settings.StopIfGoingOnBatteries = $false
    $d.Settings.RestartCount = 3
    $d.Settings.RestartInterval = 'PT1M'
    $trigger = $d.Triggers.Create(9)
    $trigger.UserId = $sid
    $trigger.Delay = 'PT15S'
    $action = $d.Actions.Create(0)
    $action.Path = $p.command
    $action.Arguments = $p.arguments
    $action.WorkingDirectory = $p.workingDirectory
    # TASK_CREATE only: a concurrent creator is never replaced.
    $null = $folder.RegisterTaskDefinition($name, $d, 2, $sid, $null, 3, $null)
    $existing = $folder.GetTask($name)
    if (!(Test-Definition $existing)) { throw 'ASSISTANT_BACKGROUND_READBACK_FAILED' }
  }
  if ($p.operation -eq 'start') {
    if (!$existing) { throw 'ASSISTANT_BACKGROUND_NOT_INSTALLED' }
    # IgnoreNew is also enforced by Windows if another caller won this race.
    if ($existing.State -ne 4 -and $existing.State -ne 2) { $null = $existing.Run($null) }
    $existing = $folder.GetTask($name)
    if (!(Test-Definition $existing)) { throw 'ASSISTANT_BACKGROUND_READBACK_FAILED' }
  }
  if ($p.operation -eq 'remove' -and $existing) {
    # Never terminate a model turn or lose its uncertain-outcome evidence.
    if ($existing.State -eq 4 -or $existing.State -eq 2) { throw 'ASSISTANT_BACKGROUND_BUSY' }
    $folder.DeleteTask($name, 0)
    try { $null = $folder.GetTask($name); throw 'ASSISTANT_BACKGROUND_READBACK_FAILED' } catch {
      if (!(Test-NotFound $_)) { throw }
    }
    $existing = $null
  }
  $state = 'not_installed'
  if ($existing) { $state = 'registered'; if ($existing.State -eq 4) { $state = 'running' }; if ($existing.State -eq 2) { $state = 'queued' } }
  $result = @{schemaVersion=1; state=$state; installed=[bool]$existing; interactiveUserRequired=$true; startsAtUserLogon=[bool]$existing; businessReady=$false}
  [Console]::Error.WriteLine('TRELIO_TASK_STAGE result')
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
} catch {
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  $code = [string]$_.Exception.Message
  if ($cause.HResult -eq -2147024891) { $code = 'ASSISTANT_BACKGROUND_ACCESS_DENIED' }
  if ($cause.HResult -eq -2147024713) { $code = 'ASSISTANT_BACKGROUND_CONFLICT' }
  if ($code -notin @('ASSISTANT_BACKGROUND_CONFLICT','ASSISTANT_BACKGROUND_BUSY','ASSISTANT_BACKGROUND_NOT_INSTALLED','ASSISTANT_BACKGROUND_READBACK_FAILED','ASSISTANT_BACKGROUND_ACCESS_DENIED')) { $code = 'ASSISTANT_BACKGROUND_UNAVAILABLE' }
  [Console]::Out.WriteLine((@{code=$code} | ConvertTo-Json -Compress))
  exit 1
}
`;

/** No provider/identity/command is supplied by a model. The caller composes
 * this with its completed protected pairing journal and current loaded shell.
 * Runtime-to-runtime injection is internal test composition, not a tool ABI.
 */
export const createAssistantWindowsBackground = ({ readIdentity, verifyContact,
  platform = process.platform, environment = process.env, executable = process.execPath,
  resolveLoader = resolveHostRuntimeLoader, runNative = runAssistantWindowsBackgroundNative, signal, expectedOrigin='https://trelio.ru', loaderArguments=[] } = {}) => {
  if (typeof readIdentity !== 'function' || typeof verifyContact !== 'function'
    || !Array.isArray(loaderArguments) || loaderArguments.length>4 || loaderArguments.some(value=>typeof value!=='string'||value.length>4096||/[\x00-\x1f\x7f]/u.test(value))) fail('ASSISTANT_BACKGROUND_UNAVAILABLE');
  return async operation => {
    const started = performance.now();
    const remaining = () => {
      const value = 45_000 - (performance.now() - started);
      if (signal?.aborted || value < 10) fail('ASSISTANT_BACKGROUND_UNAVAILABLE');
      return Math.min(40_000, Math.floor(value));
    };
    if (!operations.has(operation)) fail('ASSISTANT_BACKGROUND_INVALID_INPUT');
    if (platform !== 'win32') fail('ASSISTANT_BACKGROUND_PLATFORM_UNSUPPORTED');
    remaining();
    const identity = await readIdentity();
    if (!identity || identity.origin !== expectedOrigin || !UUID.test(identity.assistantId ?? '')
      || !UUID.test(identity.deviceId ?? '')) fail('ASSISTANT_HOST_NOT_CONFIGURED');
    const loader = await resolveLoader({ environment });
    if (!windowsPath(executable) || !windowsPath(loader)) fail('ASSISTANT_BACKGROUND_UNAVAILABLE');
    const plan = { schemaVersion: 1, operation, assistantId: identity.assistantId.toLowerCase(), deviceId: identity.deviceId.toLowerCase(),
      command: executable, arguments: `${[loader,...loaderArguments].map(quoteAssistantWindowsArgument).join(' ')} bridge assistant background`,
      workingDirectory: path.win32.dirname(executable) };
    if (operation === 'install' || operation === 'start') await verifyContact();
    // Recheck after the potentially slow network operation. Pairing another
    // device midway cannot install an old identity's scheduled task.
    const current = await readIdentity();
    if (['origin', 'assistantId', 'deviceId'].some(key => current?.[key] !== identity[key])) fail('ASSISTANT_HOST_REBIND_REQUIRED');
    const result = await runNative(plan, { environment, timeoutMs: remaining(), signal });
    remaining();
    return projectAssistantBackgroundResult(result);
  };
};

/** A replacement owns only the old scheduled task, not its executable, source
 * files or provider data. This snapshot is kept inside the existing protected
 * pairing journal. It never appears in a model result or chooses a command.
 */
export const validateAssistantBackgroundReplacementSnapshot = (snapshot, previous) => {
  if (snapshot === null) return null;
  const keys = ['schemaVersion', 'assistantId', 'deviceId', 'principalSid', 'definitionSha256'];
  if (!snapshot || Object.getPrototypeOf(snapshot) !== Object.prototype
    || Object.keys(snapshot).sort().join(',') !== keys.sort().join(',') || snapshot.schemaVersion !== 1
    || !UUID.test(previous?.assistantId ?? '') || !UUID.test(previous?.deviceId ?? '')
    || snapshot.assistantId !== previous.assistantId.toLowerCase() || snapshot.deviceId !== previous.deviceId.toLowerCase()
    || !/^S-1-(?:5-21|12-1)-[0-9-]{1,180}$/u.test(snapshot.principalSid ?? '')
    || !/^[a-f0-9]{64}$/u.test(snapshot.definitionSha256 ?? '')) fail('ASSISTANT_BACKGROUND_CONFLICT');
  return Object.freeze(Object.fromEntries(keys.map(key => [key, snapshot[key]])));
};

const projectAssistantBackgroundReplacementResult = (result, previous, removing = false) => {
  if (codes.has(result?.code)) fail(result.code);
  if (!result || Object.getPrototypeOf(result) !== Object.prototype
    || Object.keys(result).sort().join(',') !== 'schemaVersion,snapshot,state' || result.schemaVersion !== 1
    || !UUID.test(previous?.assistantId ?? '') || !UUID.test(previous?.deviceId ?? '')
    || !['not_installed', 'registered', 'running', 'queued'].includes(result.state)
    || (result.state === 'not_installed') !== (result.snapshot === null)
    || removing && result.state !== 'not_installed') fail('ASSISTANT_BACKGROUND_READBACK_FAILED');
  return { schemaVersion: 1, state: result.state, snapshot: validateAssistantBackgroundReplacementSnapshot(result.snapshot, previous) };
};

/** Trusted pairing composition only: the owner has separately authorized the
 * exact old/new identities before remove is called. Inspect has no mutation;
 * remove never stops a running/queued task, executes a captured path, imports
 * its sessions, or upgrades the ordinary installer's no-overwrite policy.
 * Each operation retains the original Windows 45s/40s budgets and single OS
 * attempt. A lost delete response is reconciled as absent on the next inspect.
 */
export const createAssistantWindowsBackgroundReplacement = ({ readIdentity,
  platform = process.platform, environment = process.env, runNative = runAssistantWindowsBackgroundNative,
  signal, expectedOrigin = 'https://trelio.ru' } = {}) => {
  if (typeof readIdentity !== 'function') fail('ASSISTANT_BACKGROUND_UNAVAILABLE');
  const invoke = async (previous, operation, original = null) => {
    const started = performance.now();
    const remaining = () => {
      const budget = 45_000 - (performance.now() - started);
      if (signal?.aborted || budget < 10) fail('ASSISTANT_BACKGROUND_UNAVAILABLE');
      return Math.min(40_000, Math.floor(budget));
    };
    if (!previous || previous.origin !== expectedOrigin || !UUID.test(previous.assistantId ?? '') || !UUID.test(previous.deviceId ?? ''))
      fail('ASSISTANT_HOST_NOT_CONFIGURED');
    const selected = { origin: expectedOrigin, assistantId: previous.assistantId.toLowerCase(), deviceId: previous.deviceId.toLowerCase() };
    const assertCurrent = async () => {
      remaining();
      const current = await readIdentity();
      if (['origin', 'assistantId', 'deviceId'].some(key => current?.[key] !== selected[key])) fail('ASSISTANT_HOST_REBIND_REQUIRED');
      remaining();
    };
    await assertCurrent();
    const snapshot = validateAssistantBackgroundReplacementSnapshot(original, selected);
    // Windows is the only supported OS registration. Other platforms have no
    // Trelio Task Scheduler registration to adopt, remove or translate.
    if (platform !== 'win32') {
      if (snapshot !== null) fail('ASSISTANT_BACKGROUND_CONFLICT');
      return { schemaVersion: 1, state: 'not_installed', snapshot: null };
    }
    const result = await runNative({ schemaVersion: 1, operation,
      assistantId: selected.assistantId, deviceId: selected.deviceId,
      command: '', arguments: '', workingDirectory: '', snapshot }, { environment, signal, timeoutMs: remaining() });
    await assertCurrent();
    return projectAssistantBackgroundReplacementResult(result, selected, operation === 'replacement_remove');
  };
  return { inspect: previous => invoke(previous, 'replacement_inspect'),
    remove: (previous, snapshot) => invoke(previous, 'replacement_remove', snapshot) };
};

export const projectAssistantBackgroundResult = value => {
  if (codes.has(value?.code)) fail(value.code);
  const keys = ['schemaVersion', 'state', 'installed', 'interactiveUserRequired', 'startsAtUserLogon', 'businessReady'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',') || value.schemaVersion !== 1
    || !['not_installed', 'registered', 'running', 'queued'].includes(value.state)
    || value.installed !== (value.state !== 'not_installed') || value.interactiveUserRequired !== true
    || value.startsAtUserLogon !== value.installed || value.businessReady !== false) fail('ASSISTANT_BACKGROUND_READBACK_FAILED');
  return value;
};

/** Public registration metadata is the only input/output. Output/error pipes
 * are bounded and projected, including spawn failures and native diagnostics.
 * No raw stderr, arbitrary exception, environment or OS task definition leaves
 * this boundary, and an ambiguous registration/start is never retried.
 */
export const runAssistantWindowsBackgroundNative = (plan, { environment = process.env,
  spawnProcess = spawn, timeoutMs = 40_000, signal } = {}) => new Promise((resolve, reject) => {
  const root = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (!windowsPath(root) || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 40_000) {
    reject(Object.assign(new Error(), { code: 'ASSISTANT_BACKGROUND_UNAVAILABLE' })); return;
  }
  let child, done = false, output = '', bytes = 0;
  const finish = (error, result) => {
    if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); child?.kill?.();
    error ? reject(Object.assign(new Error(), { code: error })) : resolve(result);
  };
  const abort = () => finish('ASSISTANT_BACKGROUND_UNAVAILABLE');
  const timer = setTimeout(() => finish('ASSISTANT_BACKGROUND_UNAVAILABLE'), timeoutMs);
  if (signal?.aborted) return abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    child = spawnProcess(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ASSISTANT_WINDOWS_BACKGROUND_SCRIPT, 'utf16le').toString('base64')],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']
          .filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]])) });
    child.once('error', () => finish('ASSISTANT_BACKGROUND_UNAVAILABLE'));
    child.stdin.on('error', () => finish('ASSISTANT_BACKGROUND_UNAVAILABLE'));
    child.stdout.on('data', chunk => {
      bytes += chunk.length; if (bytes > 4096) return finish('ASSISTANT_BACKGROUND_READBACK_FAILED');
      // The native envelope is ASCII only. Split UTF-8 sequences cannot hide
      // a path/message because only known ASCII keys/enum values are accepted.
      output += chunk.toString('utf8');
    });
    child.once('close', code => {
      let value; try { value = JSON.parse(output); } catch { return finish('ASSISTANT_BACKGROUND_READBACK_FAILED'); }
      if (code !== 0 && !codes.has(value?.code)) return finish('ASSISTANT_BACKGROUND_UNAVAILABLE');
      // Both operations use the SAME bounded native pipe. The internal
      // replacement receipt deliberately has no public readiness/install fields;
      // it must reach its own strict projector rather than being mistaken for
      // a malformed ordinary registration response. Never pass raw JSON through.
      try { finish(null, ['replacement_inspect', 'replacement_remove'].includes(plan.operation)
        ? projectAssistantBackgroundReplacementResult(value, plan, plan.operation === 'replacement_remove')
        : projectAssistantBackgroundResult(value)); } catch (error) { finish(error.code); }
    });
    child.stdin.end(JSON.stringify(plan));
  } catch { finish('ASSISTANT_BACKGROUND_UNAVAILABLE'); }
});
