import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {read} from './git-coordinator.mjs';
import {readRuntimeCiPlan} from './runtime-ci-plan.mjs';
import {prepareWindowsWorkerForLocalChecks} from './runtime-windows-worker-preflight.mjs';

const signedChainSuite = 'tests/trelio-hook-signed-chain.test.mjs';

const isTest = file => /^(?:scripts|tests)\/[^/]+\.test\.mjs$/u.test(file);
const isJavaScript = file => /\.(?:mjs|js|cjs)$/u.test(file);
const isText = file => /\.(?:mjs|js|cjs|json|sh|ps1)$/u.test(file);
const maintainerDocument = file => /^(?:(?:AGENTS|README|SECURITY)\.md|docs\/.+\.md)$/u.test(file);
const gitInputs = new Set(['git-coordination.json', '.gitattributes',
  '.githooks/pre-commit', '.githooks/pre-push', ...[
    'git-coordinator.mjs', 'git-background.mjs', 'git-follow-up.mjs', 'git-hosted-ci.mjs', 'git-finish-worktree.mjs',
    'git-main-guard.sh', 'assert-coordination.mjs', 'push-main.sh', 'assert-clean-worktree.sh',
    'configure-canonical-main.sh', 'create-task-worktree.sh',
  ].map(file => `scripts/${file}`)]);

// A nested npm project is both an input to these suites and a prerequisite
// when the same suites are selected via their source imports. Keep both
// directions in one reviewed mapping: a lock file alone does not explain
// which tests load its modules (browser suites may load them conditionally).
const lockedTestPackages = new Map([
  ['host-runtime/scripts/visual-browser-dependencies', [
    'tests/trelio-visual-browser.test.mjs',
    'tests/trelio-visual-auth.test.mjs',
    'tests/trelio-visual-extension-browser.test.mjs',
    'tests/trelio-visual-native-store.test.mjs',
    'tests/trelio-local-form.test.mjs',
  ]],
  ['tests/fixtures/deepseek-native', ['tests/trelio-deepseek-native.test.mjs']],
]);
const npmManifests = ['package.json', 'package-lock.json'];

// These boundaries load native files, discover directories or compose paths at
// runtime. Such edges cannot be proven by literal imports. Keep their owners
// explicit and small: additions need a reviewed suite, never a generic smoke
// that happens to pass without exercising the changed input. Native OS lanes
// and deterministic package builds remain part of the unchanged full release.
const owners = new Map([
  ['host-runtime/scripts/native-private-process/PrivateProcess.cpp', ['tests/trelio-windows-native-private.test.mjs']],
  ['host-runtime/scripts/native-bridge-keychain/BridgeKeychain.swift', ['tests/trelio-hook-private-session.test.mjs']],
  ['host-runtime/scripts/native-secret-browser/SecretBrowser.cs', ['tests/trelio-secret-browser-native.test.mjs']],
  ['host-runtime/scripts/native-secret-browser/SecretBrowser.swift', ['tests/trelio-secret-browser-native.test.mjs']],
  ...[...lockedTestPackages].flatMap(([directory, suites]) =>
    npmManifests.map(manifest => [`${directory}/${manifest}`, suites])),
  ['host-runtime/scripts/trelio-assistant-entry.mjs', ['tests/trelio-assistant-transport.test.mjs']],
  ['scripts/build-host-runtime-package.mjs', ['tests/trelio-host-runtime-entry.test.mjs', signedChainSuite]],
  ['scripts/build-windows-private-worker.ps1', ['tests/trelio-windows-native-private.test.mjs']],
  ['.github/workflows/runtime-tests.yml', ['scripts/runtime-ci-plan.test.mjs', 'scripts/runtime-main-checks.test.mjs']],
  ['.github/scripts/run-windows-account-fixture.ps1', ['tests/trelio-skill-accounts.test.mjs']],
  ['.github/scripts/run-windows-acl-standard-user.ps1', ['tests/trelio-windows-native-private.test.mjs']],
  ['.github/scripts/run-windows-codex-mcp-fixture.ps1', ['tests/trelio-codex-mcp.test.mjs', 'tests/trelio-codex-conversation.test.mjs']],
  ['.github/scripts/run-windows-package-service-fixture.ps1', ['tests/trelio-windows-native-private.test.mjs']],
  ['scripts/bootstrap-worktree-dependencies.sh', ['scripts/bootstrap-worktree-dependencies.test.sh']],
  ['scripts/bootstrap-worktree-dependencies.test.sh', ['scripts/bootstrap-worktree-dependencies.test.sh']],
]);

/** Find only literal module loads and file URLs. Candidate sources are data:
 * never import/evaluate them while planning. Query/hash suffixes identify the
 * same source. Computed imports, directory enumeration and path joins require
 * explicit owners above. Text assertions are direct evidence only; reading a
 * giant entrypoint as text does not execute all of its dependencies.
 */
export function sourceReferences(file, source) {
  const imports = new Set(), reads = new Set();
  const resolve = value => {
    if (!/^\.{1,2}\//u.test(value) || value.includes('\\') || value.includes('${')) return null;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), value.split(/[?#]/u)[0]));
    return target.startsWith('../') ? null : target;
  };
  const importPatterns = [
    /\b(?:import|export)\s+(?:[^;'"`]*?\bfrom\s*)?["']([^"'\r\n]+)["']/gu,
    /\bimport\s*\(\s*["'`]([^"'`\r\n]+)["'`]\s*(?=[,)])/gu,
  ];
  for (const pattern of importPatterns) for (const match of source.matchAll(pattern)) {
    const target = resolve(match[1]); if (target) imports.add(target);
  }
  const urlPattern = /\bnew\s+URL\(\s*["'`]([^"'`\r\n]+)["'`]\s*,\s*import\.meta\.url\s*,?\s*\)/gu;
  for (const match of source.matchAll(urlPattern)) {
    const target = resolve(match[1]); if (target) reads.add(target);
  }
  return {imports, reads};
}

function add(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function impactGraph(snapshots) {
  const executionOwners = new Map(), literalOwners = new Map(), consumers = new Map();
  for (const snapshot of snapshots) {
    const refs = new Map([...snapshot].filter(([, text]) => typeof text === 'string')
      .map(([file, text]) => [file, sourceReferences(file, text)]));
    for (const [file, references] of refs) {
      if (file.startsWith('tests/') || isTest(file)) continue;
      for (const dependency of [...references.imports, ...references.reads]) add(consumers, dependency, file);
    }
    for (const suite of [...snapshot.keys()].filter(isTest)) {
      const visited = new Set();
      const inspect = file => {
        if (visited.has(file)) return;
        visited.add(file);
        for (const dependency of refs.get(file)?.imports ?? []) {
          add(executionOwners, dependency, suite);
          // Test helpers are part of the suite, not a production boundary.
          // Follow them fully, but do not explode through every production
          // import of a large Workspace/assistant entrypoint.
          if (dependency.startsWith('tests/') && !isTest(dependency)) inspect(dependency);
        }
        for (const dependency of refs.get(file)?.reads ?? []) add(literalOwners, dependency, suite);
      };
      inspect(suite);
    }
  }
  return {executionOwners, literalOwners, consumers};
}

/** Main is a focused boundary gate, not a claim of full impact coverage.
 * Select direct owners plus the nearest tested boundary on EACH consumer
 * branch, even when the changed helper has its own test. Stop only after that
 * boundary has execution coverage; textual assertions never stop traversal.
 * Union both revisions so deletions/renames cannot erase their old consumers.
 */
export function planMainChecks(paths, {before, after}) {
  const syntax = new Set(), tests = new Set(), reasons = new Map(), unmapped = [];
  let dependencies = false, coordination = false;
  const graph = impactGraph([before, after]);
  const available = suite => typeof after.get(suite) === 'string';
  const select = (suite, reason) => {
    if (!available(suite)) return false;
    tests.add(suite); add(reasons, suite, reason); return true;
  };
  const selectOwners = (file, reason, includeReads) => {
    let covered = false;
    const direct = [...(graph.executionOwners.get(file) ?? [])];
    const peer = `tests/${path.posix.basename(file).replace(/\.[^.]+$/u, '')}.test.mjs`;
    // A consumer boundary runs its own proven suite, not every suite that
    // imports that consumer. Otherwise Workspace's many unrelated clients
    // would turn a small helper change back into the release-wide set. The
    // changed module itself still runs ALL direct owners, including non-peer
    // consumers. A reviewed dynamic owner is also an explicit boundary.
    const boundary = owners.get(file) ?? (direct.includes(peer) && available(peer) ? [peer] : direct);
    for (const suite of includeReads ? [...direct, ...(owners.get(file) ?? [])] : boundary)
      covered = select(suite, reason) || covered;
    if (includeReads) for (const suite of graph.literalOwners.get(file) ?? [])
      covered = select(suite, reason) || covered;
    return covered;
  };
  const selectImpact = file => {
    let covered = selectOwners(file, `direct:${file}`, true);
    const visited = new Set([file]);
    const walk = dependency => {
      for (const consumer of graph.consumers.get(dependency) ?? []) {
        if (visited.has(consumer)) continue;
        visited.add(consumer);
        // A surviving consumer must still have a surviving test. Old-only
        // module edges remain useful for locating the replacement boundary.
        const boundary = selectOwners(consumer, `consumer:${file}->${consumer}`, false);
        covered = boundary || covered;
        if (!boundary) walk(consumer);
      }
    };
    walk(file); return covered;
  };
  for (const file of paths) {
    if (maintainerDocument(file) || file === '.gitignore') continue;
    if (isJavaScript(file) && after.has(file)) syntax.add(file);
    if (gitInputs.has(file) || file === 'scripts/git-main-guard.test.sh') {
      coordination = true; continue;
    }
    if (isTest(file)) {
      if (after.has(file)) { select(file, `changed-test:${file}`); continue; }
      // A removed test is not success. A real rename with identical bytes can
      // run its new path; otherwise require surviving coverage of its former
      // inputs. Removal of the only suite fails until coverage is replaced.
      const replacements = [...after].filter(([name, text]) => isTest(name) && text === before.get(file));
      if (replacements.length) { for (const [name] of replacements) select(name, `renamed-test:${file}`); continue; }
      const inputs = sourceReferences(file, before.get(file) ?? '');
      const targets = new Set([...inputs.imports, ...inputs.reads]);
      if (!targets.size || [...targets].some(target => !selectImpact(target)))
        unmapped.push(`${file}: removed test has no surviving coverage for all former inputs`);
      continue;
    }
    if (file === 'package.json' || file === 'package-lock.json') {
      dependencies = true;
      select('tests/context-budget.test.mjs', `dependency:${file}`);
      // The package also defines the guarded commands. Only script changes
      // require Git transport fixtures; a tokenizer lock update does not.
      if (file === 'package.json' && JSON.stringify(JSON.parse(before.get(file) ?? '{}').scripts)
        !== JSON.stringify(JSON.parse(after.get(file) ?? '{}').scripts)) coordination = true;
      continue;
    }
    if (!selectImpact(file)) unmapped.push(`${file}: no surviving test owner; add a focused test or reviewed owner mapping`);
  }
  if (coordination) {
    // The composite script runs these two exactly once with its shell fixture.
    for (const suite of ['scripts/git-coordinator.test.mjs', 'scripts/git-finish-worktree.test.mjs']) {
      tests.delete(suite); reasons.delete(suite);
    }
  }
  if (unmapped.length) throw Error(`Unmapped main checks:\n${unmapped.join('\n')}`);

  const testPackages = [];
  for (const [directory, suites] of lockedTestPackages) {
    if (!suites.some(suite => tests.has(suite))) continue;
    // Require both files in the candidate before npm can touch the checkout.
    // A removed lock must fail here even if yesterday's modules are present.
    for (const manifest of npmManifests) {
      const file = `${directory}/${manifest}`;
      if (typeof after.get(file) !== 'string') throw Error(`Missing main-check package input: ${file}`);
    }
    testPackages.push(directory);
  }
  return {syntax: [...syntax].sort(), tests: [...tests].sort(), dependencies, testPackages, coordination,
    reasons: Object.fromEntries([...reasons].sort().map(([suite, values]) => [suite, [...values].sort()]))};
}

/** Read committed objects in two bounded Git children, not one git-show per
 * source. NUL tree framing, exact OIDs/modes and complete batch byte counts
 * reject partial output, warnings and symlinked source without executing it.
 */
export function readMainCheckSnapshot(repository, revision) {
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw Error('Invalid impact snapshot revision');
  const git = (args, input) => {
    const result = spawnSync('git', ['-C', repository, ...args], {input, maxBuffer: 32 * 1024 * 1024, shell: false});
    if (result.error || result.status !== 0 || result.stderr.length) throw Error('Cannot read complete main-check snapshot');
    return result.stdout;
  };
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const raw = decoder.decode(git(['ls-tree', '-r', '-z', revision]));
  const records = raw.split('\0');
  if (records.pop() !== '' || records.length > 10000) throw Error('Incomplete main-check inventory');
  const snapshot = new Map(), sources = [];
  for (const record of records) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([^\0]+)$/u.exec(record);
    if (!match || snapshot.has(match[3])) throw Error('Invalid main-check inventory');
    const [, mode, oid, file] = match;
    if (file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f\\]/u.test(file))
      throw Error('Invalid main-check path');
    if (mode === '120000') throw Error(`Unsupported main-check symlink: ${file}`);
    snapshot.set(file, null);
    if (isText(file)) sources.push({file, oid});
  }
  if (!sources.length) return snapshot;
  const bytes = git(['cat-file', '--batch'], sources.map(({oid}) => oid + '\n').join(''));
  let offset = 0;
  for (const {file, oid} of sources) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw Error('Incomplete main-check objects');
    const header = /^([a-f0-9]{40}) blob (\d+)$/u.exec(bytes.subarray(offset, end).toString('ascii'));
    const size = Number(header?.[2]); offset = end + 1;
    if (!header || header[1] !== oid || !Number.isSafeInteger(size) || size > 4 * 1024 * 1024
      || offset + size >= bytes.length || bytes[offset + size] !== 10) throw Error('Invalid main-check object');
    snapshot.set(file, decoder.decode(bytes.subarray(offset, offset + size))); offset += size + 1;
  }
  if (offset !== bytes.length) throw Error('Unexpected main-check object tail');
  return snapshot;
}

function run(executable, args, cwd) {
  console.log(`Local check: ${path.basename(executable)} ${args.join(' ')}`);
  const result = spawnSync(executable, args, {cwd, stdio: 'inherit', shell: false});
  if (result.error || result.status !== 0) throw Error(`Local check failed: ${executable} ${args.join(' ')}`);
}

async function main([baseSha, headSha, ...extra]) {
  const cwd = process.cwd();
  if (extra.length || !/^[a-f0-9]{40}$/u.test(baseSha ?? '') || !/^[a-f0-9]{40}$/u.test(headSha ?? '')
    || read('git', ['rev-parse', 'refs/remotes/origin/main'], cwd) !== baseSha
    || read('git', ['rev-parse', 'HEAD'], cwd) !== headSha) throw Error('Local checks require the exact rebased candidate');
  const {changedPaths} = readRuntimeCiPlan({repository: cwd, baseSha, headSha});
  run('git', ['diff', '--check', baseSha, headSha], cwd);
  const plan = planMainChecks(changedPaths, {before: readMainCheckSnapshot(cwd, baseSha), after: readMainCheckSnapshot(cwd, headSha)});
  console.log(JSON.stringify({mainChecks: plan}));
  if (plan.tests.length || plan.dependencies || plan.coordination) run('npm', ['run', 'check:dependencies'], cwd);
  for (const file of plan.syntax) run(process.execPath, ['--check', file], cwd);
  // Resolve the hosted packaging input before running any affected suites.
  // Other focused plans do not need GitHub access or a populated bin directory.
  if (plan.tests.includes(signedChainSuite)) {
    const source = await prepareWindowsWorkerForLocalChecks(cwd, baseSha, headSha);
    console.log('Windows private worker verified: ' + source);
  }
  // Reconcile each selected package once before any suite runs. Reuse npm's
  // download cache, but rebuild node_modules from this candidate's lock rather
  // than accepting a warm tree that may still reflect the pre-rebase lock.
  for (const directory of plan.testPackages) {
    run('npm', ['ci', '--prefix', directory, '--include=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], cwd);
  }
  for (const file of plan.tests) run(file.endsWith('.sh') ? 'bash' : process.execPath, [file], cwd);
  if (plan.coordination) run('npm', ['run', 'test:git-guard'], cwd);
  console.log(`Local main checks passed for ${headSha}: ${plan.tests.length} affected suites`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
