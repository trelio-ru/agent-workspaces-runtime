import crypto from "node:crypto";
import { canonicalJson } from "./trelio-company-encryption.mjs";

export const SKILL_SECRET_SETUP_FILE = "trelio-secret-setup.json";
const invalid = () => new Error("Подписанная декларация настройки навыка недействительна.");
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** The provider owns CLI classification in the SAME signed file inventory.
 * Absence is not legacy permission: a package that has not reviewed its task
 * surface cannot run with assistant credentials. This is a restriction only;
 * a matching command still needs live task/account/action authority. No model
 * flag, environment value or unsigned resolve metadata supplies this policy.
 */
export const assertAssistantTaskSkillCommand = (parsedPackage, runtimeArguments) => {
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const files = parsedPackage?.files?.filter(file => file.path === 'trelio-assistant-execution.json') ?? [];
  if (!files.length) fail('ASSISTANT_SKILL_COMMAND_UNAVAILABLE');
  if (files.length !== 1 || !Buffer.isBuffer(files[0].bytes) || files[0].bytes.length > 8192)
    fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
  let policy;
  try { policy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files[0].bytes)); }
  catch { fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID'); }
  const version = policy?.schemaVersion;
  if (![1,2].includes(version)
    || !exactKeys(policy, version === 2 ? ['schemaVersion', 'taskCommands', 'deniedOptions'] : ['schemaVersion', 'taskCommands'])
    || !Array.isArray(policy.taskCommands) || !policy.taskCommands.length || policy.taskCommands.length > 64)
    fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
  const seen = new Set();
  for (const prefix of policy.taskCommands) {
    if (!Array.isArray(prefix) || !prefix.length || prefix.length > 3
      || prefix.some(token => typeof token !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(token))
      || seen.has(JSON.stringify(prefix))) fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
    seen.add(JSON.stringify(prefix));
  }
  const deniedOptions = version === 2 ? policy.deniedOptions : [];
  if (version === 2 && (!Array.isArray(deniedOptions) || !deniedOptions.length || deniedOptions.length > 32
    || new Set(deniedOptions).size !== deniedOptions.length
    || deniedOptions.some(option => typeof option !== 'string' || !/^--[a-z][a-z0-9-]{0,63}$/u.test(option))))
    fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
  let setup;
  try { setup = readSkillSetupDescriptor(parsedPackage); }
  catch { fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID'); }
  // A broad provider task prefix must not make its explicitly declared human
  // login an ordinary unattended command. Its dedicated native owner/account
  // grant and original human-input deadline remain an independent boundary.
  if (setup?.humanInputCommands?.some(command => JSON.stringify(command.arguments) === JSON.stringify(runtimeArguments)))
    fail('ASSISTANT_SKILL_COMMAND_DENIED');
  // Literal positional tokens only. No regex/glob, shell expansion, substring
  // matching, option skipping or parser abbreviation can broaden a prefix.
  // Provider arguments after it retain their existing strict native parser.
  if (!Array.isArray(runtimeArguments) || runtimeArguments.some(arg => typeof arg !== 'string')
    // A reviewed provider may have a legitimate human executable/window/budget
    // override (e.g. MAX --chrome). Its signed restriction, not a host-owned
    // provider map, closes both token spellings before any account/bootstrap.
    // Providers must review their native parser aliases/abbreviations too;
    // literal deny cannot promise to classify an undeclared synonym.
    || runtimeArguments.some(arg => deniedOptions.some(option => arg === option || arg.startsWith(`${option}=`)))
    || !policy.taskCommands.some(prefix => prefix.every((token, index) => runtimeArguments[index] === token)))
    fail('ASSISTANT_SKILL_COMMAND_DENIED');
};

/** Both setup purposes read the SAME complete signed descriptor. A human-input
 * declaration contains no Secret binding/env or model slots and never weakens
 * the legacy v1 or value-bearing v2 command grammar. */
const readSkillSetupDescriptor = (parsedPackage) => {
  const file = parsedPackage.files.find((item) => item.path === SKILL_SECRET_SETUP_FILE);
  if (!file) return null;
  if (!Buffer.isBuffer(file.bytes) || file.bytes.length > 16 * 1024) throw invalid();
  let descriptor;
  try { descriptor = JSON.parse(file.bytes.toString("utf8")); } catch { throw invalid(); }
  if (!exactKeys(descriptor, ["schemaVersion", "commands", ...(Object.hasOwn(descriptor ?? {}, "humanInputCommands") ? ["humanInputCommands"] : [])])
    || ![1,2].includes(descriptor.schemaVersion) || !Array.isArray(descriptor.commands) || descriptor.commands.length > 8
    || descriptor.schemaVersion === 1 && (descriptor.humanInputCommands !== undefined || !descriptor.commands.length)
    || descriptor.humanInputCommands !== undefined && (!Array.isArray(descriptor.humanInputCommands)
      || !descriptor.humanInputCommands.length || descriptor.humanInputCommands.length > 8)
    || !descriptor.commands.length && !descriptor.humanInputCommands?.length
    || descriptor.commands.length && !parsedPackage.capabilities.includes("secret-checkout")
    || descriptor.humanInputCommands?.length && !parsedPackage.capabilities.includes("local-session")) throw invalid();
  const ids = new Set();
  const argumentSets = new Set();
  for (const command of descriptor.commands) {
    if (!exactKeys(command, ["id", "arguments", "bindingKey", "fieldKey", "environmentVariable",
      ...(descriptor.schemaVersion===2?["purpose"]:[])])
      || descriptor.schemaVersion===2 && command.purpose!=="authenticate"
      || typeof command.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/u.test(command.id)
      || !Array.isArray(command.arguments) || !command.arguments.length || command.arguments.length > 8
      || command.arguments.some((arg) => typeof arg !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(arg))
      || [command.bindingKey, command.fieldKey].some((key) => typeof key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(key))
      || typeof command.environmentVariable !== "string" || !/^TRELIO_[A-Z0-9_]{1,100}$/u.test(command.environmentVariable)
      || command.environmentVariable.startsWith("TRELIO_SKILL_")
      || ["TRELIO_CONFIG_HOME", "TRELIO_CACHE_HOME", "TRELIO_ORIGIN"].includes(command.environmentVariable)
      || ids.has(command.id) || argumentSets.has(JSON.stringify(command.arguments))) throw invalid();
    ids.add(command.id);
    argumentSets.add(JSON.stringify(command.arguments));
  }
  for (const command of descriptor.humanInputCommands ?? []) {
    if (!exactKeys(command, ["id", "purpose", "arguments", ...(Object.hasOwn(command ?? {}, "maximumDurationMs") ? ["maximumDurationMs"] : [])])
      || command.purpose !== "authenticate_existing"
      || typeof command.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/u.test(command.id)
      || !Array.isArray(command.arguments) || !command.arguments.length || command.arguments.length > 8
      || command.arguments.some(arg => typeof arg !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(arg))
      || command.maximumDurationMs !== undefined && (!Number.isSafeInteger(command.maximumDurationMs)
        || command.maximumDurationMs < 60_000 || command.maximumDurationMs > 600_000)
      || ids.has(command.id) || argumentSets.has(JSON.stringify(command.arguments))) throw invalid();
    ids.add(command.id); argumentSets.add(JSON.stringify(command.arguments));
  }
  return descriptor;
};

/** Read only bytes whose package signature and per-file hashes were verified. */
export const readSkillSecretSetupCommand = (parsedPackage, runtimeArguments) =>
  readSkillSetupDescriptor(parsedPackage)?.commands.find(command => JSON.stringify(command.arguments) === JSON.stringify(runtimeArguments)) ?? null;

/** A native-owned ID selects exact signed argv; no caller argv, Secret field,
 * environment override or registration purpose is accepted by this reader. */
export const readSkillHumanInputSetupCommand = (parsedPackage, commandId) =>
  readSkillSetupDescriptor(parsedPackage)?.humanInputCommands?.find(command => command.id === commandId) ?? null;

/**
 * A setup request cannot use an arbitrary secret id, executable, env name or
 * argument prefix. The server resolves them from its own signed package and
 * current connection. Never cache/print the response or retry a failed delivery.
 */
export const deliverSkillSetupEnvironment = async ({ request, origin, token, command, resolution,
  companyId, projectId, skillId, releaseId, runtimeSessionId }) => {
  const connection = resolution.companyConnection;
  const identity = resolution.localIdentity;
  if (!connection?.configured || !identity?.memberId || identity.connectionId !== connection.id) {
    throw new Error("Сначала настройте подключение навыка для компании.");
  }
  const configSha256 = crypto.createHash("sha256").update(canonicalJson(connection.config)).digest("hex");
  const expected = {
    schemaVersion: 1, companyId, memberId: identity.memberId, releaseId,
    artifactId: resolution.artifact.id, packageSha256: resolution.artifact.packageSha256,
    connectionId: connection.id, configSha256, commandId: command.id,
    environmentVariable: command.environmentVariable,
  };
  const response = await request(origin, token, "/api/agent-skills/runtime/setup-secret", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId, projectId, skillId, expectedReleaseId: releaseId,
      artifactId: expected.artifactId, packageSha256: expected.packageSha256,
      connectionId: connection.id, configSha256, commandId: command.id, runtimeSessionId }),
  });
  const result = await response.json();
  if (!exactKeys(result, [...Object.keys(expected), "value"])
    || Object.entries(expected).some(([key, value]) => result[key] !== value)
    || typeof result.value !== "string" || !result.value.length
    || Buffer.byteLength(result.value, "utf8") > 64 * 1024 || result.value.includes("\0")) {
    // Never interpolate a malformed value-bearing response in an error.
    throw new Error("Trelio вернул несовпадающее разрешение настройки навыка.");
  }
  return { [command.environmentVariable]: result.value };
};
