import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildIsolatedPythonRuntimeArguments,
  buildPythonInvocationCandidates,
  resolveTrustedPythonInvocation,
  sanitizeAgentSkillInheritedEnvironment,
} from "../host-runtime/scripts/trelio-workspace.mjs";

const execFileAsync = promisify(execFile);

test("Windows Python discovery includes standard per-user installations with stale PATH", () => {
  const userRoot = "C:\\Users\\Owner\\AppData\\Local\\Programs\\Python";
  const candidates = buildPythonInvocationCandidates({
    platform: "win32",
    homeDirectory: "C:\\Users\\Owner",
    environment: {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      SystemRoot: "C:\\Windows",
      // Ambient overrides must not choose either the user identity or an
      // interpreter. The caller may be a skill running inside a workspace.
      Path: "C:\\workspace\\bin",
      LOCALAPPDATA: "C:\\workspace",
      USERPROFILE: "C:\\workspace",
    },
  });
  const executables = candidates.map((candidate) => candidate.executable);
  for (const version of ["314", "313", "312", "311", "310"]) {
    for (const suffix of ["", "-32", "-64", "-arm64"]) {
      const installationRoot = path.win32.join(userRoot, `Python${version}${suffix}`);
      assert.deepEqual(
        candidates.find((candidate) => candidate.executable === path.win32.join(installationRoot, "python.exe")),
        { executable: path.win32.join(installationRoot, "python.exe"), argsPrefix: [], installationRoot },
      );
    }
    for (const root of ["C:\\Program Files", "C:\\Program Files (x86)"]) {
      assert.ok(executables.includes(path.win32.join(root, `Python${version}`, "python.exe")));
      assert.ok(executables.includes(path.win32.join(root, `Python 3.${version.slice(1)}`, "python.exe")));
    }
  }
  assert.equal(executables.some((executable) => executable.includes("workspace")), false);
  assert.deepEqual(candidates.at(-1), { executable: "C:\\Windows\\py.exe", argsPrefix: ["-3"] });
});

test("Windows Python discovery rejects relative, UNC and nonstandard installation roots", () => {
  for (const homeDirectory of ["", "relative", "C:relative", "\\\\server\\share\\user"]) {
    assert.deepEqual(buildPythonInvocationCandidates({
      platform: "win32",
      homeDirectory,
      environment: {
        PROGRAMFILES: "C:\\workspace\\Program Files",
        "PROGRAMFILES(X86)": "relative\\Program Files (x86)",
        SYSTEMROOT: "\\\\server\\share\\Windows",
        PATH: "C:\\workspace",
      },
    }), []);
  }
});

test("POSIX Python discovery keeps fixed interpreter roots and ignores ambient PATH", () => {
  const candidates = buildPythonInvocationCandidates({
    platform: "linux",
    homeDirectory: "/workspace/home",
    environment: { PATH: "/workspace/bin" },
  });
  assert.deepEqual(candidates.map((candidate) => candidate.executable), [
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "/bin/python3",
    "/run/current-system/sw/bin/python3",
    "/nix/var/nix/profiles/default/bin/python3",
  ]);
  assert.equal(candidates.every((candidate) => candidate.argsPrefix.length === 0), true);
});

test("Windows host runs a per-user Python in isolation and rejects forbidden or redirected roots", {
  skip: process.platform !== "win32",
  timeout: 90_000,
}, async (t) => {
  // Hosted setup-python supplies the source distribution. Relocate its actual
  // executable, DLLs and standard library to the official per-user layout:
  // resolving the toolcache copy directly would not exercise this regression.
  const sourceDirectory = process.env.pythonLocation;
  if (!sourceDirectory) {
    if (process.env.CI) assert.fail("Windows CI must provide Python 3.13 through setup-python");
    t.skip("Set pythonLocation to a Python 3.13 installation to run the Windows fixture");
    return;
  }
  const installationRoot = path.join(os.userInfo().homedir, "AppData", "Local", "Programs", "Python", "Python313");
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-python-user-test-"));
  const runtimeDirectory = path.join(temporaryDirectory, "runtime");
  const hostileDirectory = path.join(temporaryDirectory, "hostile-bin");
  const markerPath = path.join(temporaryDirectory, "hostile-ran");
  let fixtureKind = null;
  try {
    await fs.mkdir(path.dirname(installationRoot), { recursive: true });
    // Never overwrite a real installation. Only a root created by this test
    // belongs to its cleanup; an existing Python313 makes the fixture fail.
    await fs.mkdir(installationRoot);
    fixtureKind = "directory";
    for (const entry of await fs.readdir(sourceDirectory, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name === "python.exe" || entry.name.endsWith(".dll"))) {
        await fs.copyFile(path.join(sourceDirectory, entry.name), path.join(installationRoot, entry.name));
      }
    }
    await fs.cp(path.join(sourceDirectory, "Lib"), path.join(installationRoot, "Lib"), {
      recursive: true,
      filter: (source) => !["site-packages", "__pycache__"].includes(path.basename(source)),
    });
    await fs.cp(path.join(sourceDirectory, "DLLs"), path.join(installationRoot, "DLLs"), { recursive: true });
    await fs.mkdir(runtimeDirectory);
    await fs.mkdir(hostileDirectory);
    await fs.writeFile(path.join(hostileDirectory, "python.cmd"), `@echo off\r\necho bad>"${markerPath}"\r\n`);
    await fs.writeFile(
      path.join(runtimeDirectory, "sitecustomize.py"),
      `import pathlib;pathlib.Path(${JSON.stringify(markerPath)}).write_text('bad')\n`,
    );
    const inheritedEnvironment = {
      // Omit machine roots to force discovery of the per-user installation.
      // Keep an explicitly hostile/stale process PATH and Python startup env.
      PATH: hostileDirectory,
      PYTHONPATH: runtimeDirectory,
      PYTHONSTARTUP: path.join(runtimeDirectory, "sitecustomize.py"),
      LOCALAPPDATA: temporaryDirectory,
      USERPROFILE: temporaryDirectory,
    };
    const invocation = await resolveTrustedPythonInvocation({ runtimeDirectory, environment: inheritedEnvironment });
    assert.equal(invocation.executable.toLowerCase(), path.join(installationRoot, "python.exe").toLowerCase());
    assert.equal(invocation.version, "3.13");
    assert.deepEqual(invocation.argsPrefix, []);

    const entrypointPath = path.join(runtimeDirectory, "main.py");
    await fs.writeFile(path.join(runtimeDirectory, "helper.py"), "VALUE = 'signed-sibling-import'\n");
    await fs.writeFile(entrypointPath, "import json,sys\nfrom helper import VALUE\nprint(json.dumps([VALUE, sys.flags.isolated, sys.flags.dont_write_bytecode]))\n");
    const { stdout } = await execFileAsync(invocation.executable, buildIsolatedPythonRuntimeArguments({
      runtimeDirectory,
      entrypointPath,
      runtimeArguments: [],
    }), { cwd: runtimeDirectory, env: sanitizeAgentSkillInheritedEnvironment(inheritedEnvironment), encoding: "utf8", timeout: 5_000 });
    assert.deepEqual(JSON.parse(stdout.trim()), ["signed-sibling-import", 1, 1]);
    assert.equal(await fs.stat(markerPath).catch(() => null), null);

    // The same executable cannot become trusted just because its path matches
    // an installer layout while that directory is the active skill workspace.
    await assert.rejects(resolveTrustedPythonInvocation({
      runtimeDirectory: installationRoot,
      environment: inheritedEnvironment,
    }), /установка для всех пользователей не обязательна/u);

    // Windows junctions need no developer-mode symlink privilege. A standard
    // directory name redirecting to an arbitrary installation remains denied.
    await fs.rm(installationRoot, { recursive: true });
    fixtureKind = null;
    await fs.symlink(sourceDirectory, installationRoot, "junction");
    fixtureKind = "junction";
    await assert.rejects(resolveTrustedPythonInvocation({
      runtimeDirectory,
      environment: inheritedEnvironment,
    }), /Не найден подходящий Python/u);
  } finally {
    if (fixtureKind === "junction") await fs.unlink(installationRoot);
    if (fixtureKind === "directory") await fs.rm(installationRoot, { recursive: true, force: true });
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
