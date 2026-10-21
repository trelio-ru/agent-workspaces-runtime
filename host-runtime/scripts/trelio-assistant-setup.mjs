/** Model-visible setup composes the existing protected S256/device client.
 * Only structural receipts leave this boundary; raw verifier/credential stays
 * inside the common OS-backed store and fixed HTTPS transport. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveHostRuntimeLoader } from './trelio-host-runtime-recovery.mjs';
import { createAssistantPairingClient, createAssistantDeviceClient } from './trelio-assistant-transport.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export class AssistantSetupError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AssistantSetupError(code); };
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('ASSISTANT_SETUP_INVALID_INPUT'); return value.toLowerCase(); };
export const createAssistantSetup = ({ origin, store, http, now = Date.now }) => {
  const pairing = createAssistantPairingClient({ origin, store, http, now });
  const key = enrollmentId => ({ origin, kind: 'pairing', id: id(enrollmentId) });
  const paired = async record => {
    if (record.origin !== origin) fail('ASSISTANT_SETUP_RECOVERY_REQUIRED');
    const assistantId = id(record.assistantId), deviceId = id(record.deviceId);
    const client = createAssistantDeviceClient({ origin, assistantId, deviceId, store, http });
    // A completed pairing receipt is not an offline grant. It must still
    // survive live expiry, revocation and owner checks before reporting contact.
    await client.heartbeat();
    return { state: 'paired', assistantId, deviceId, businessReady: false,
      requiredCapabilities: ['task_pass_admission', 'background_service'] };
  };
  const status = async enrollmentId => {
    const record = await store.get(key(enrollmentId));
    if (!record) return { state: 'not_started' };
    if (record.phase === 'complete') return paired(record);
    if (record.phase === 'exchanging') return { state: 'recovery_required' };
    if (record.phase === 'prepared') return { state: 'prepared' };
    if (record.phase !== 'pending' || !Number.isSafeInteger(record.expiresAt)
      || !/^[A-F0-9]{8}$/u.test(record.verificationCode ?? '')) fail('ASSISTANT_SETUP_RECOVERY_REQUIRED');
    return { state: record.expiresAt <= now() ? 'expired' : 'waiting_owner',
      verificationCode: record.verificationCode, expiresAt: record.expiresAt };
  };
  return {
    status,
    async begin(enrollmentId, deviceName) {
      id(enrollmentId);
      const record = await store.get(key(enrollmentId));
      if (record?.phase === 'complete') return paired(record);
      const result = await pairing.begin(enrollmentId, deviceName);
      return { state: 'waiting_owner', verificationCode: result.verificationCode, expiresAt: result.expiresAt };
    },
    async finish(enrollmentId) {
      const record = await store.get(key(enrollmentId));
      if (record?.phase === 'complete') return paired(record);
      const result = await pairing.exchange(enrollmentId);
      if (result.state === 'pending') return { state: 'waiting_owner' };
      return paired({ phase: 'complete', ...result });
    },
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
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($sid -notmatch '^S-1-(5-21|12-1)-[0-9-]+$') { throw 'ASSISTANT_BACKGROUND_UNAVAILABLE' }
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $folder = $service.GetFolder('\')
  $name = 'Trelio-DigitalAssistant-' + $p.assistantId
  $marker = 'Trelio digital assistant background v1 ' + $p.assistantId + '/' + $p.deviceId
  $existing = $null
  function Test-NotFound($failure) {
    $cause = $failure.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    return $cause.HResult -eq -2147024894
  }
  try { $existing = $folder.GetTask($name) } catch {
    if (!(Test-NotFound $_)) { throw }
  }
  function Test-Definition($task) {
    $d = $task.Definition
    $checks = @{
      marker = $d.RegistrationInfo.Description -ceq $marker
      principal = $d.Principal.UserId -ceq $sid
      logon = $d.Principal.LogonType -eq 3 -and $d.Principal.RunLevel -eq 0
      action_count = $d.Actions.Count -eq 1
      action_type = $d.Actions.Item(1).Type -eq 0
      action_path = $d.Actions.Item(1).Path -ceq $p.command
      action_arguments = $d.Actions.Item(1).Arguments -ceq $p.arguments
      action_cwd = $d.Actions.Item(1).WorkingDirectory -ceq $p.workingDirectory
      trigger_count = $d.Triggers.Count -eq 1
      trigger_type = $d.Triggers.Item(1).Type -eq 9
      trigger_user = $d.Triggers.Item(1).UserId -ceq $sid
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
  resolveLoader = resolveHostRuntimeLoader, runNative = runAssistantWindowsBackgroundNative, signal } = {}) => {
  if (typeof readIdentity !== 'function' || typeof verifyContact !== 'function') fail('ASSISTANT_BACKGROUND_UNAVAILABLE');
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
    if (!identity || identity.origin !== 'https://trelio.ru' || !UUID.test(identity.assistantId ?? '')
      || !UUID.test(identity.deviceId ?? '')) fail('ASSISTANT_HOST_NOT_CONFIGURED');
    const loader = await resolveLoader({ environment });
    if (!windowsPath(executable) || !windowsPath(loader)) fail('ASSISTANT_BACKGROUND_UNAVAILABLE');
    const plan = { schemaVersion: 1, operation, assistantId: identity.assistantId.toLowerCase(), deviceId: identity.deviceId.toLowerCase(),
      command: executable, arguments: `${quoteAssistantWindowsArgument(loader)} bridge assistant background`,
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
      try { finish(null, projectAssistantBackgroundResult(value)); } catch (error) { finish(error.code); }
    });
    child.stdin.end(JSON.stringify(plan));
  } catch { finish('ASSISTANT_BACKGROUND_UNAVAILABLE'); }
});
