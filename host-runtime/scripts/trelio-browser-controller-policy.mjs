/** Pure signed opt-in/argv classification, before private or provider I/O. */
import path from 'node:path';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const validUuid = value => typeof value === 'string' && uuid.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** The opt-in lives in the SAME verified package inventory. A capability name
 * or model-supplied environment value alone must not open a command surface.
 * Assistant task policies remain separate and cannot inherit this human API. */
export function browserControllerEnabled(parsedPackage) {
  const files = parsedPackage?.files?.filter(file => file.path === 'trelio-browser-controller.json') ?? [];
  if (!files.length) return false;
  let marker;
  try { marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files[0].bytes)); } catch {}
  if (files.length !== 1 || !Buffer.isBuffer(files[0].bytes) || files[0].bytes.length > 1024
    || !exact(marker, ['schemaVersion']) || marker.schemaVersion !== 1
    || !parsedPackage.browserSession || !['browser', 'local-session'].every(value => parsedPackage.capabilities.includes(value)))
    fail('BROWSER_CONTROLLER_POLICY_INVALID');
  return true;
}

export function parseBrowserControllerArguments(args) {
  if (args[0] !== 'browser-controller') return null;
  const [_, operation, sessionId, requestId, option, inputFile] = args;
  const afterSequence = operation === 'status' && args.length === 5 && requestId === '--after-sequence'
    && /^(?:0|[1-9][0-9]{0,15})$/u.test(option || '') && Number.isSafeInteger(Number(option)) ? Number(option) : null;
  if (!validUuid(sessionId)
    || !(['status', 'close'].includes(operation) && args.length === 3
      || operation === 'status' && afterSequence !== null
      || operation === 'poll' && args.length === 4 && validUuid(requestId)
      || operation === 'submit' && args.length === 6 && validUuid(requestId) && option === '--input-file'
        && typeof inputFile === 'string' && path.isAbsolute(inputFile)))
    fail('BROWSER_CONTROLLER_ARGUMENTS_INVALID');
  return { operation, sessionId, requestId, inputFile, afterSequence };
}
