import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRuntimeHookBudget, buildPrivateAclWorkerScript, createPrivateAclWorker, privateProcessOptions,
  runtimeHookSignal, scopedPrivateAclWorker, withRuntimeHookPrivateSession, withRuntimeHookStage, withPrivateProcessSession,
} from "../host-runtime/scripts/trelio-hook-private-session.mjs";
import {
  hardenWindowsPrivatePath, resolveWindowsPowerShellExecutable, WINDOWS_PRIVATE_ACL_SCRIPT,
  protectWindowsBridgeSessionToken, unprotectWindowsBridgeSessionToken, buildWindowsBridgeDpapiInvocation,
} from "../host-runtime/scripts/trelio-workspace.mjs";

// This child only implements the value-free IPC protocol. It never starts
// PowerShell or reads a credential, and works on every supported CI platform.
const fixtureSource = `
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
console.log(JSON.stringify({ready: true}));
lines.on('line', line => {
  const [id, kind, path] = line.split('\\t');
  const request = {id, kind, path};
  const mode = Buffer.from(request.path, 'base64').toString('utf8');
  if (mode === 'stall') return;
  if (mode === 'phase-stall') {
    console.log(JSON.stringify({id: request.id, phase: 'dacl_verify'}));
    return;
  }
  if (mode === 'invalid-phase') {
    console.log(JSON.stringify({id: request.id, phase: 'private-user-path-or-secret'}));
    return;
  }
  if (mode === 'invalid') { console.log('not-json'); return; }
  if (mode === 'exit') { process.exit(1); return; }
  console.log(JSON.stringify({ id: request.id, ok: mode !== 'deny' }));
});
`;
const fixtureSpawner = (state) => (executable, args, options) => {
  state.starts++;
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
  assert.equal(args[args.length - 2], "-EncodedCommand");
  const child = spawn(process.execPath, ["-e", fixtureSource], options);
  state.children.push(child);
  return child;
};
const fixtureOptions = (state) => ({
  executable: "synthetic-powershell", aclScript: "# fixed synthetic ACL implementation",
  spawnProcess: fixtureSpawner(state),
});
const assertStopped = async (state) => {
  for (const child of state.children) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once("close", resolve));
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
};

test("one hook reuses one ACL process but verifies every path, and closes it before returning", async () => {
  const state = { starts: 0, children: [] };
  await withRuntimeHookPrivateSession(5_000, async () => {
    const first = scopedPrivateAclWorker(fixtureOptions(state));
    for (let index = 0; index < 20; index++) {
      const worker = scopedPrivateAclWorker(fixtureOptions(state));
      assert.equal(worker, first);
      await worker.harden("synthetic path Ж ' $()", index % 2 ? "file" : "directory");
    }
    // Even a previously successful path must still reach the child. An error
    // on that same transport is rejected, not hidden by a cached ACL result.
    await assert.rejects(first.harden("deny", "file"), /Windows не подтвердил/u);
  });
  assert.equal(state.starts, 1);
  await assertStopped(state);
  await withRuntimeHookPrivateSession(5_000, async () => {
    await scopedPrivateAclWorker(fixtureOptions(state)).harden("new-hook", "file");
  });
  assert.equal(state.starts, 2);
  await assertStopped(state);
});

test("hook-wide deadline cancels a stalled ACL child and leaves the next hook usable", async () => {
  const state = { starts: 0, children: [] };
  await withRuntimeHookPrivateSession(100, async () => {
    await assert.rejects(
      scopedPrivateAclWorker(fixtureOptions(state)).harden("stall", "directory"),
      { code: "TRELIO_RUNTIME_HOOK_FAILED" },
    );
    assert.throws(assertRuntimeHookBudget, { code: "TRELIO_RUNTIME_HOOK_FAILED" });
  });
  await assertStopped(state);
  await withRuntimeHookPrivateSession(5_000, async () => {
    await scopedPrivateAclWorker(fixtureOptions(state)).harden("retry", "file");
  });
  await assertStopped(state);
});

test("a single ACL request has its own bound and cannot silently respawn after failure", async () => {
  const state = { starts: 0, children: [] };
  const worker = createPrivateAclWorker({ ...fixtureOptions(state), requestTimeoutMilliseconds: 100 });
  try {
    await assert.rejects(worker.harden("stall", "directory"));
    await assert.rejects(worker.harden("retry", "directory"));
    assert.equal(state.starts, 1);
  } finally { await worker.close(); }
  await assertStopped(state);
});

for (const mode of ["invalid", "invalid-phase", "exit"]) {
  test(`ACL worker ${mode} response is a failure with no child output disclosure`, async () => {
    const state = { starts: 0, children: [] };
    const worker = createPrivateAclWorker(fixtureOptions(state));
    try {
      await assert.rejects(worker.harden(mode, "file"), (error) => {
        assert.equal(error.stdout, undefined);
        assert.equal(error.stderr, undefined);
        assert.doesNotMatch(error.message, /not-json|synthetic-powershell|private-user-path-or-secret/u);
        return true;
      });
    } finally { await worker.close(); }
    await assertStopped(state);
  });
}

for (const timeoutKind of ["hook", "private_process"]) {
  test(`ACL ${timeoutKind} timeout reports the waiting operation without disclosing the path`, async () => {
    const state = { starts: 0, children: [] };
    await withRuntimeHookPrivateSession(timeoutKind === "hook" ? 1_500 : 5_000, async () => {
      const worker = scopedPrivateAclWorker({
        ...fixtureOptions(state), requestTimeoutMilliseconds: timeoutKind === "hook" ? 5_000 : 1_500,
      });
      await assert.rejects(withRuntimeHookStage("runtime_state_read", () => worker.harden("phase-stall", "file")), (error) => {
        assert.equal(error.code, "TRELIO_RUNTIME_HOOK_FAILED");
        assert.equal(error.hookStage, "runtime_state_read");
        assert.equal(error.operation, "windows_acl.dacl_verify");
        assert.equal(error.timeoutKind, timeoutKind);
        assert.match(error.message, /stage=runtime_state_read/u);
        assert.doesNotMatch(error.message, /phase-stall/u);
        return true;
      });
    });
    await assertStopped(state);
  });
}

test("private subprocesses receive both a local timeout and the exact non-sliding hook signal", async () => {
  assert.equal(runtimeHookSignal(), undefined);
  assert.equal(privateProcessOptions().timeout, 10_000);
  await withRuntimeHookPrivateSession(5_000, async () => {
    const signal = runtimeHookSignal();
    assert.equal(privateProcessOptions().signal, signal);
    assert.equal(privateProcessOptions().signal, signal);
  });
  assert.equal(runtimeHookSignal(), undefined);
});

test("Windows hook ACL transport executes the original owner-only verification for special paths", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trelio-hook-acl-worker-"));
  const directory = path.join(root, "spaces Ж ' $() ; [path]");
  const file = path.join(directory, "private.json");
  try {
    await mkdir(directory);
    await writeFile(file, "{}\n");
    await withRuntimeHookPrivateSession(8_000, async () => {
      // Repeated calls are real descriptor checks inside the same process.
      await hardenWindowsPrivatePath(directory, "directory");
      await hardenWindowsPrivatePath(file, "file");
      await hardenWindowsPrivatePath(file, "file");
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows ACL verification works when the PowerShell account-name adapter is unavailable", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trelio-hook-acl-sid-"));
  const file = path.join(root, "private.json");
  // Replace only PowerShell's name-resolving convenience property. Real SID
  // identity, descriptor writes and GetAccessRules remain native Windows calls.
  // The old verifier touches this getter; direct SID verification must not.
  const guard = `
$script:accountLookupCount = 0
foreach ($typeName in @("System.Security.AccessControl.FileSecurity", "System.Security.AccessControl.DirectorySecurity")) {
  Update-TypeData -TypeName $typeName -MemberType ScriptProperty -MemberName Access -Force -Value {
    $script:accountLookupCount++
    throw "Synthetic unavailable account-name resolver"
  }
}
`;
  const worker = createPrivateAclWorker({
    executable: resolveWindowsPowerShellExecutable(),
    aclScript: WINDOWS_PRIVATE_ACL_SCRIPT
      + '\nif ($script:accountLookupCount -ne 0) { throw "Account-name lookup was used" }',
    spawnProcess: (program, args, options) => {
      // Test-only type adapter registration precedes the production worker's
      // disabled module autoload. The ACL operation itself uses only .NET.
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      return spawn(program, [...args.slice(0, -1), Buffer.from(guard + script, "utf16le").toString("base64")], options);
    },
  });
  try {
    await writeFile(file, "{}\n");
    await worker.harden(root, "directory");
    await worker.harden(file, "file");
    await worker.harden(file, "file");
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ACL requests wait for readiness, with a separate startup diagnostic and unchanged deadline", async () => {
  for (const ready of [false, true]) {
    const children = [];
    let receivedBytes = 0;
    const worker = createPrivateAclWorker({
      executable: "fixture", aclScript: "", requestTimeoutMilliseconds: 250, startupTimeoutMilliseconds: 250,
      spawnProcess: (_program, _args, options) => {
        const child = spawn(process.execPath, ["-e", `
          process.stdin.resume();
          ${ready ? "console.log(JSON.stringify({ready:true}));" : ""}
        `], options);
        // Observe stdin writes in the parent without recording path bytes.
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (chunk, ...args) => { receivedBytes += chunk.length; return write(chunk, ...args); };
        children.push(child);
        return child;
      },
    });
    try {
      await assert.rejects(worker.harden("synthetic", "file"), (error) => {
        if (!ready) {
          assert.equal(error.operation, "windows_acl.worker_startup");
          assert.equal(error.timeoutKind, "private_process");
          assert.equal(receivedBytes, 0);
        } else {
          assert.ok(receivedBytes > 0);
          assert.equal(error.operation, "windows_acl.request_dispatch");
        }
        return true;
      });
    } finally { await worker.close(); }
    await assertStopped({children});
  }
});

test("Windows ACL helper owns raw UTF-8 pipes without console wrappers or module cmdlets", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trelio-acl-raw-pipe-"));
  const file = path.join(root, "unicode Ж ' $() [file].json");
  // Fault injection before the actual production helper: a host may replace
  // Console.In/Out, while cmdlet/module discovery is an unrelated dependency.
  // The old worker calls New-Object before its first phase and times out here.
  // Raw pipes and direct .NET ACL operations must remain independent of both.
  const guard = `
[Console]::SetIn([System.IO.StringReader]::new(""))
[Console]::SetOut([System.IO.TextWriter]::Null)
function New-Object { [System.Threading.Thread]::Sleep(30000) }
function ConvertFrom-Json { throw "Unexpected JSON cmdlet dependency" }
function ConvertTo-Json { throw "Unexpected JSON cmdlet dependency" }
function Where-Object { throw "Unexpected pipeline dependency" }
function Remove-Item { throw "Unexpected provider dependency" }
`;
  const worker = createPrivateAclWorker({
    executable: resolveWindowsPowerShellExecutable(), aclScript: WINDOWS_PRIVATE_ACL_SCRIPT,
    requestTimeoutMilliseconds: 5_000,
    spawnProcess: (program, args, options) => {
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      return spawn(program, [...args.slice(0,-1), Buffer.from(guard + script, "utf16le").toString("base64")], options);
    },
  });
  try {
    await writeFile(file, "{}\n");
    await worker.harden(root, "directory");
    await worker.harden(file, "file");
    // Each path still gets fresh native verification, even with no cmdlets.
    await worker.harden(file, "file");
  } finally {
    await worker.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("ACL wire script does not change console encoding or invoke module discovery", () => {
  const script = buildPrivateAclWorkerScript(WINDOWS_PRIVATE_ACL_SCRIPT);
  assert.doesNotMatch(script, /Console\]::(?:InputEncoding|OutputEncoding|ReadLine|WriteLine)|New-Object|ConvertFrom-Json|ConvertTo-Json|Where-Object|Remove-Item/u);
});

test("a slow but healthy startup does not consume the operation timeout or spawn a second worker", async () => {
  let starts = 0;
  const children = [];
  const worker = createPrivateAclWorker({ executable: "fixture", aclScript: "",
    startupTimeoutMilliseconds: 2_000, requestTimeoutMilliseconds: 200,
    spawnProcess: (_program, _args, options) => {
      starts++;
      const child = spawn(process.execPath, ["-e", `
        const rl=require('node:readline').createInterface({input:process.stdin});
        setTimeout(()=>console.log(JSON.stringify({ready:true})), 400);
        rl.on('line',line=> {
          const [id,kind,entropy,value]=line.split('\\t');
          console.log(JSON.stringify(kind==='file'?{id,ok:true}:{id,ok:true,value}));
        });
      `], options);
      children.push(child); return child;
    },
  });
  try {
    await worker.harden("synthetic", "file");
    const input = Buffer.from("synthetic-private-value");
    const output = await worker.dpapi("protect", Buffer.alloc(32, 1), input);
    assert.deepEqual(output, input); output.fill(0);
    assert.equal(starts, 1);
  } finally { await worker.close(); }
  await assertStopped({children});
});

test("the global deadline still bounds slow startup plus successful progress", async () => {
  const children = [];
  await withRuntimeHookPrivateSession(450, async () => {
    const worker = scopedPrivateAclWorker({ executable: "fixture", aclScript: "",
      startupTimeoutMilliseconds: 2_000, requestTimeoutMilliseconds: 2_000,
      spawnProcess: (_program, _args, options) => {
        const child = spawn(process.execPath, ["-e", `
          setTimeout(()=>console.log(JSON.stringify({ready:true})), 100);
          require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
            const [id]=line.split('\\t');
            setTimeout(()=>console.log(JSON.stringify({id,phase:'identity'})),100);
          });
        `], options); children.push(child); return child;
      },
    });
    await assert.rejects(worker.harden("synthetic", "file"), error => {
      assert.equal(error.timeoutKind, "hook"); return true;
    });
  });
  await assertStopped({children});
});

for (const response of ['bad-json-with-synthetic-secret', '{"id":"1","ok":false,"value":"c2VjcmV0"}', '{"id":"1","ok":true,"value":"@@@"}']) {
  test("invalid DPAPI response is rejected without disclosing plaintext: " + response.slice(0, 12), async () => {
    const worker = createPrivateAclWorker({ executable:"fixture", aclScript:"", spawnProcess: (_program,_args,options) =>
      spawn(process.execPath, ["-e", `console.log(JSON.stringify({ready:true}));process.stdin.once('data',()=>console.log(${JSON.stringify(response)}))`], options) });
    try {
      await assert.rejects(worker.dpapi("unprotect",Buffer.alloc(32,1),Buffer.from("synthetic")), error => {
        assert.doesNotMatch(JSON.stringify(error) + error.message, /synthetic-secret|c2VjcmV0|@@@/u);
        assert.equal(error.stdout,undefined); assert.equal(error.stderr,undefined); return true;
      });
    } finally { await worker.close(); }
  });
}

test("Windows slow cold startup shares ACL and legacy-compatible DPAPI under the unchanged hook deadline", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trelio-slow-private-worker-"));
  const value = "synthetic-token-Ж-test";
  const origin = "https://fixture.invalid";
  const runLegacy = async (mode,input) => {
    const invocation=buildWindowsBridgeDpapiInvocation(origin,mode);
    return new Promise((resolve,reject)=>{
      const child=spawn(invocation.executable,invocation.args,{shell:false,windowsHide:true,
        env:{...process.env,...invocation.environment},stdio:['pipe','pipe','ignore']});
      let output='';
      const timer=setTimeout(()=>{child.kill();reject(Error('Synthetic legacy fixture timed out'));},10000);
      child.stdout.on('data',chunk=>{output+=chunk;});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);code===0?resolve(output.trim()):reject(Error('Synthetic legacy fixture failed'));});
      child.stdin.end(input+'\n');
    });
  };
  const legacy = await runLegacy('protect',value);
  let currentCiphertext;
  let starts = 0;
  try {
    await withRuntimeHookPrivateSession(22_000, async () => {
      const worker = scopedPrivateAclWorker({ executable:resolveWindowsPowerShellExecutable(), aclScript:WINDOWS_PRIVATE_ACL_SCRIPT,
        spawnProcess: (program,args,options) => {
          starts++;
          const script = '[Threading.Thread]::Sleep(13000)\nfunction Add-Type { throw "Unexpected module dependency" }\n'
            + Buffer.from(args.at(-1),'base64').toString('utf16le');
          return spawn(program,[...args.slice(0,-1),Buffer.from(script,'utf16le').toString('base64')],options);
        } });
      await hardenWindowsPrivatePath(root,"directory");
      assert.equal(await unprotectWindowsBridgeSessionToken(origin,legacy),value);
      const ciphertext = await protectWindowsBridgeSessionToken(origin,value);
      currentCiphertext=ciphertext;
      assert.equal(await unprotectWindowsBridgeSessionToken(origin,ciphertext),value);
      await hardenWindowsPrivatePath(root,"directory");
      assert.equal(worker,scopedPrivateAclWorker({}));
      assert.equal(starts,1);
    });
    assert.equal(await runLegacy('unprotect',currentCiphertext),value);
  } finally { await rm(root,{recursive:true,force:true}); }
});


test("standalone invocation reuses and reaps one worker without sharing it with the next invocation", async () => {
  const state = { starts: 0, children: [] };
  for (let index = 0; index < 2; index++) {
    await withPrivateProcessSession(async () => {
      const worker = scopedPrivateAclWorker(fixtureOptions(state));
      await worker.harden("synthetic", "file");
      await withPrivateProcessSession(async () => {
        assert.equal(scopedPrivateAclWorker(fixtureOptions(state)), worker);
        await worker.harden("synthetic", "file");
      });
    });
    assert.equal(state.starts, index + 1);
    await assertStopped(state);
  }
});

test("DPAPI operation timeout retains its stage and rejects reuse without leaking input", async () => {
  const children = [];
  const worker = createPrivateAclWorker({ executable: "fixture", aclScript: "",
    requestTimeoutMilliseconds: 200,
    spawnProcess: (_program, _args, options) => {
      const child = spawn(process.execPath, ["-e",
        "console.log(JSON.stringify({ready:true}));process.stdin.resume()"], options);
      children.push(child); return child;
    },
  });
  try {
    await assert.rejects(withRuntimeHookStage("bridge_credentials", () =>
      worker.dpapi("unprotect", Buffer.alloc(32, 1), Buffer.from("synthetic-private-input"))), error => {
      assert.equal(error.hookStage, "bridge_credentials");
      assert.equal(error.operation, "windows_dpapi.unprotect");
      assert.equal(error.timeoutKind, "private_process");
      assert.doesNotMatch(error.message, /synthetic-private-input/u);
      return true;
    });
    await assert.rejects(worker.harden("another-operation", "file"));
    assert.equal(children.length, 1);
  } finally { await worker.close(); }
  await assertStopped({ children });
});
