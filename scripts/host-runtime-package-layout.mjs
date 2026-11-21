// Maintainer-only layout. The local Git gate and the deterministic builder
// share which tracked paths affect the signed package's file inventory.
export const hostRuntimeScripts = 'host-runtime/scripts';

export const windowsWorkerFiles = Object.freeze([
  'PrivateProcess.cpp', 'bin/metadata.json',
  ...['x64', 'ia32', 'arm64'].map(arch => `bin/${arch}/trelio-private-process.exe`),
]);
export const visualDependencyFiles = Object.freeze(['package.json', 'package-lock.json']);
export const nativeSourceDirectories = Object.freeze(['native-secret-browser', 'native-bridge-keychain']);

export const includesHostRuntimeScript = name => !name.includes('/') && name !== 'report-context-budget.mjs'
  && (name.endsWith('.mjs') || name === 'trelio-agent-diagnostics-contract.json');

export const isHostRuntimePackageInput = file => {
  if (!file.startsWith(hostRuntimeScripts + '/')) return false;
  const name = file.slice(hostRuntimeScripts.length + 1);
  return includesHostRuntimeScript(name)
    || windowsWorkerFiles.some(relative => name === 'native-private-process/' + relative)
    || visualDependencyFiles.some(relative => name === 'visual-browser-dependencies/' + relative)
    || nativeSourceDirectories.some(directory => name.startsWith(directory + '/'));
};
