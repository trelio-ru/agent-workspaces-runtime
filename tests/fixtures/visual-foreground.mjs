import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

const macObserver = `
import AppKit
import Foundation

func report(_ pid: pid_t) {
    FileHandle.standardOutput.write(Data("\\(pid)\\n".utf8))
}
let workspace = NSWorkspace.shared
let subscription = workspace.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
) { notification in
    if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
        report(app.processIdentifier)
    }
}
report(workspace.frontmostApplication?.processIdentifier ?? 0)
RunLoop.main.run()
`;

const windowsObserver = `
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Microsoft.PowerShell.Core\\Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class TrelioForegroundObserver {
    private delegate void WinEvent(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential)]
    private struct Message {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x, y;
        public uint reserved;
    }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message msg, IntPtr hwnd, uint min, uint max, uint remove);
    private static void Report(IntPtr hwnd) {
        uint pid = 0;
        if (hwnd != IntPtr.Zero) GetWindowThreadProcessId(hwnd, out pid);
        Console.WriteLine(pid);
        Console.Out.Flush();
    }
    public static void Run() {
        // An out-of-context event hook can see activation even if the native
        // window loses foreground again before the host's next command.
        WinEvent callback = (hook, ev, hwnd, obj, child, thread, time) => Report(hwnd);
        if (SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0) == IntPtr.Zero)
            throw new InvalidOperationException();
        Report(GetForegroundWindow());
        while (true) {
            Message msg;
            while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) {}
            GC.KeepAlive(callback);
            Thread.Sleep(10);
        }
    }
}
'@
[TrelioForegroundObserver]::Run()
`;

export async function observeVisualForeground(signal) {
  const windows = process.platform === 'win32';
  const executable = windows
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : '/usr/bin/swift';
  const args = windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsObserver, 'utf16le').toString('base64')]
    : ['-e', macObserver];
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  // This testing helper observes native events only. Never send simulated input
  // or reactivate the previous app to make a foreground check pass.
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
  signal.addEventListener('abort', stop, { once: true });
  const lines = createInterface({ input: child.stdout });
  let baseline, changes = 0;
  const closed = new Promise(resolve => child.once('close', resolve));
  const started = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => reject(new Error('Native foreground observer exited')));
    lines.on('line', line => {
      if (!/^\d+$/u.test(line)) return;
      const pid = Number(line);
      if (baseline === undefined) { baseline = pid; resolve(); }
      else if (pid !== baseline) changes++;
    });
  });
  try { await started; }
  catch (error) { stop(); throw error; }
  return {
    assertUnchanged(message) {
      assert.equal(child.exitCode === null && child.signalCode === null, true, 'native foreground observer is still running');
      assert.equal(changes, 0, message);
    },
    async close() { stop(); await closed; signal.removeEventListener('abort', stop); },
  };
}
