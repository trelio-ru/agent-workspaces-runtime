import crypto from "node:crypto";
import path from "node:path";
import { canonicalJson } from "./trelio-company-encryption.mjs";
import { assistantArtifactPathDigest, sameLocalPath } from "./trelio-local-path.mjs";
import { splitAccountArguments } from "./trelio-skill-accounts.mjs";

export const SKILL_SECRET_SETUP_FILE = "trelio-secret-setup.json";
const invalid = () => new Error("Подписанная декларация настройки навыка недействительна.");
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const assistantTaskPrefixMatches = (prefix, args) => prefix.every((token, index) => args[index] === token);

/** Bind to the exact admitted parameters and the original pass. The parent
 * repeats this after the private pipe. Do not return or log the arguments,
 * provider config, native proof or account identifier in this witness. */
export const assistantTaskSkillReadRequestDigest = (scope, parameters) => crypto.createHash('sha256')
  .update(canonicalJson({companyId:scope.companyId,taskId:scope.taskId,passId:scope.passId,parameters}))
  .digest('hex');

const matchesTaskSkillReadOutput = (value, releaseId, stdout) =>
  value.schemaVersion === 1 && value.releaseId === releaseId
  && /^[a-f0-9]{64}$/u.test(value.packageSha256 ?? '')
  && typeof stdout === 'string'
  && value.outputSha256 === crypto.createHash('sha256').update(stdout, 'utf8').digest('hex');

export const bindAssistantTaskSkillRead = (value, { scope, parameters, stdout }) => {
  if (!exactKeys(value, ['schemaVersion', 'releaseId', 'packageSha256', 'outputSha256'])
    || !matchesTaskSkillReadOutput(value, parameters.releaseId, stdout)) return null;
  return {...value,requestSha256:assistantTaskSkillReadRequestDigest(scope,parameters)};
};

/** A provider-authored JSON field inside stdout is never a native witness.
 * Require exact bytes, release and invocation, including across truncation. */
export const matchesAssistantTaskSkillRead = (value, { scope, parameters, stdout }) =>
  exactKeys(value, ['schemaVersion', 'releaseId', 'packageSha256', 'outputSha256', 'requestSha256'])
  && matchesTaskSkillReadOutput(value, parameters.releaseId, stdout)
  && value.requestSha256 === assistantTaskSkillReadRequestDigest(scope,parameters);

/** One complete positive file-export result. The signed command declares its
 * effect, but the otherwise untrusted output merely names a candidate.
 * Only unchanged bytes in the exact later checkpoint settle that effect. */
export const assistantTaskArtifactFromOutput = (stdout, args) => {
  const at=args.indexOf('--output'), destination=args[at+1];
  if(at<0||at!==args.lastIndexOf('--output')||args.some(token=>/^--(?:output|overwrite)=/u.test(token)||token==='--overwrite')
    ||typeof destination!=='string'||!path.isAbsolute(destination)||destination.includes('\0')
    ||typeof stdout!=='string'||Buffer.byteLength(stdout)>65_536)return null;
  let result;
  try{result=JSON.parse(stdout);}catch{return null;}
  const {saved,size,sha256}=result??{};
  if(typeof saved!=='string'||!path.isAbsolute(saved)||saved.includes('\0')
    ||!sameLocalPath(path.dirname(saved),destination)
    ||!Number.isSafeInteger(size)||size<1||size>512*1024||typeof sha256!=='string'||!/^[a-f0-9]{64}$/u.test(sha256))return null;
  return {pathSha256:assistantArtifactPathDigest(saved),contentSha256:sha256,sizeBytes:size};
};

const taskSkillArtifactMatches = (value,parameters,stdout) => {
  if(!matchesTaskSkillReadOutput(value,parameters.releaseId,stdout))return false;
  let candidate;
  try{candidate=assistantTaskArtifactFromOutput(stdout,splitAccountArguments(parameters.arguments).providerArguments);}
  catch{return false;}
  return candidate&&exactKeys(value.artifact,Object.keys(candidate))
    &&Object.entries(candidate).every(([key,expected])=>value.artifact[key]===expected);
};
export const bindAssistantTaskSkillArtifact = (value,{scope,parameters,stdout}) =>
  exactKeys(value,['schemaVersion','releaseId','packageSha256','outputSha256','artifact'])
  && taskSkillArtifactMatches(value,parameters,stdout)
    ?{...value,requestSha256:assistantTaskSkillReadRequestDigest(scope,parameters)}:null;
export const matchesAssistantTaskSkillArtifact = (value,{scope,parameters,stdout}) =>
  exactKeys(value,['schemaVersion','releaseId','packageSha256','outputSha256','artifact','requestSha256'])
  && taskSkillArtifactMatches(value,parameters,stdout)
  && value.requestSha256===assistantTaskSkillReadRequestDigest(scope,parameters);

// A historical package has no typed effect receipt. The signed host can
// classify an exact reviewed old command vector, then native renewal checks
// the same immutable release, verified bytes and publication time. The
// catalog is only for retained turns. Live calls use the signed effect policy.
// These terminal-only vectors are evidence about the *already executed* old
// process. The only non-observation work is local session/cache maintenance.
// Keep them out of checkpoint resumption and never use them to run a command.
const historicalTelegramHistoryRead=(arguments_, accountId)=>{
  // The reviewed guides branch reads a fixed signed manifest before account
  // selection, credential I/O or provider startup.
  if(arguments_.length===1&&arguments_[0]==='guides')return true;
  if(accountId===null)return arguments_.length===2&&arguments_[0]==='account'&&arguments_[1]==='list';
  const peer=value=>/^-?[1-9][0-9]{0,17}$/u.test(value??'');
  const instant=value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value??'')
    &&Number.isFinite(Date.parse(value));
  if(arguments_.length===1)return arguments_[0]==='doctor';
  if(arguments_.length===3)return arguments_[0]==='chat-info'&&arguments_[1]==='--chat'&&peer(arguments_[2]);
  const [kind,chat,target,since,from,until,to,timezone,zone,links,order]=arguments_;
  if(arguments_.length!==11||kind!=='export'||chat!=='--chat'||since!=='--since'||until!=='--until'
    ||timezone!=='--timezone'||links!=='--include-links'||order!=='--chronological'
    ||!peer(target)||!instant(from)||!instant(to)||Date.parse(from)>=Date.parse(to)
    ||typeof zone!=='string'||!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+){0,3}$/u.test(zone))return false;
  try{new Intl.DateTimeFormat('en',{timeZone:zone});return true;}catch{return false;}
};

const historicalTaskSkillReads=[{
  skillId:'telegram-mtproto',releaseId:'8f0e4a2a-c63d-4aa2-958c-1fb2701c5c76',
  packageSha256:'ef85be194ef9a52c8ac20b497cd726a5487553884afd511f882be06901f8eaf0',
  // Public artifact source 0d4ec551f821ef1cfa205015a7d08ad8a7e34d6f.
  // Account list is host-owned. Signed guides fetch local resources; exact
  // read and context use get_messages without read ACK, views or reply.
  accepts(arguments_,accountId){
    if(arguments_.length===2&&arguments_[0]==='account'&&arguments_[1]==='list')return accountId===null;
    if(arguments_.length===1&&arguments_[0]==='guides')return true;
    return accountId!==null&&arguments_.length===5&&arguments_[0]==='read'
      &&arguments_[1]==='--link'&&/^https:\/\/t\.me\/(?:c\/\d+|[a-zA-Z0-9_]{1,64})\/\d+(?:\/\d+)?$/u.test(arguments_[2])
      &&arguments_[3]==='--context'&&/^(?:[0-9]|10)$/u.test(arguments_[4]);
  },
},{
  skillId:'telegram-mtproto',releaseId:'b1dabd59-00fa-42e1-a4f4-45e09081de2a',
  packageSha256:'d43aa594c16e67f808b5a01a9ddb04865330e93cfa4d7b561002a9ff72f92780',
  // Public source 181959eb24c3ef8ede4748931a3a043e22305d9f.
  // doctor never connects, chat-info reads exact rights, and the closed
  // single-chat export reads history without ACK, views, send or mutation.
  // This release predates signed effect metadata. Native reconciliation
  // also checks the publication, package digest and revocation under lock.
  terminalOnly:true,accepts:historicalTelegramHistoryRead,
}];
export const reviewedAssistantHistoricalSkillRead = ({skillId,releaseId},{providerArguments,accountId},{terminal=false}={})=>{
  const policy=historicalTaskSkillReads.find(row=>row.skillId===skillId&&row.releaseId===releaseId);
  if(!policy||policy.terminalOnly&&!terminal||!policy.accepts(providerArguments,accountId))return null;
  return {skillId,releaseId,packageSha256:policy.packageSha256};
};

/** Compatibility for one pre-receipt package, exclusively in the native
 * intermediate-draft classifier. The live catalogue attests this immutable
 * package and the server rechecks its digest and publication. The regular
 * task executor and other historical recovery states never use this audit.
 *
 * Source 205892438b5d773e3be424a3c4cad80e6af717d0: doctor disables SMTP repair,
 * SEARCH and FETCH use read-only IMAP selection/BODY.PEEK, and save-message
 * writes a single exclusive RFC822 file. Its stdout is only a claim until
 * the common verifier finds the same bytes in the exact portable draft.
 */
export const reviewedHistoricalCheckpointSkill = ({skillId,releaseId},{providerArguments,accountId},stdout) => {
  if(skillId!=='email-imap-smtp'||releaseId!=='353b28f3-8c94-4d69-a287-5f66ae953484')return null;
  const release={skillId,releaseId,packageSha256:'ef3374b49e7e5cc09330515fac6d97ec8579d64591da09726d89ad9610f238cb'};
  const [command,...tail]=providerArguments;
  if(accountId===null)return command==='account'&&tail.length===1&&tail[0]==='list'?{release}:null;
  if(['guides','doctor','folders'].includes(command))return tail.length===0?{release}:null;
  if(command==='policy')return tail.length===1&&tail[0]==='show'?{release}:null;
  const options=command==='search'?['--folder','--limit','--since','--from','--subject']
    :command==='read'?['--folder','--uid']:command==='save-message'?['--folder','--uid','--output']:null;
  if(!options||tail.length!==2*(command==='search'?4:options.length))return null;
  const values=new Map();
  for(let index=0;index<tail.length;index+=2){
    const name=tail[index], value=tail[index+1];
    if(!options.includes(name)||values.has(name)||typeof value!=='string'||!value||value.startsWith('--')||/[\0\r\n]/u.test(value))
      return null;
    values.set(name,value);
  }
  if(!values.has('--folder'))return null;
  if(command==='search'){
    const limit=Number(values.get('--limit')),since=values.get('--since');
    return Number.isInteger(limit)&&limit>=1&&limit<=100&&/^\d{4}-\d{2}-\d{2}$/u.test(since??'')
      &&(values.has('--from')||values.has('--subject'))?{release}:null;
  }
  const uid=values.get('--uid');
  if(!/^[1-9][0-9]{0,9}$/u.test(uid??''))return null;
  if(command==='read')return {release};
  const output=values.get('--output');
  if(!path.isAbsolute(output))return null;
  let result;
  try{result=JSON.parse(stdout);}catch{return null;}
  const artifact=assistantTaskArtifactFromOutput(stdout,providerArguments);
  if(!artifact||result?.uid!==uid||result.format!=='message/rfc822'
    ||!sameLocalPath(result.saved,path.join(output,`message-${uid}.eml`)))return null;
  return {release,artifact};
};

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
  if (![1,2,3,4].includes(version)
    || !exactKeys(policy, ['schemaVersion', 'taskCommands',
      ...(version >= 2 ? ['deniedOptions'] : []), ...(version >= 3 ? ['readOnlyCommands'] : []),
      ...(version === 4 ? ['localArtifactCommands'] : [])])
    || !Array.isArray(policy.taskCommands) || !policy.taskCommands.length || policy.taskCommands.length > 64)
    fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
  const seen = new Set();
  for (const prefix of policy.taskCommands) {
    if (!Array.isArray(prefix) || !prefix.length || prefix.length > 3
      || prefix.some(token => typeof token !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(token))
      || seen.has(JSON.stringify(prefix))) fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
    seen.add(JSON.stringify(prefix));
  }
  const deniedOptions = version >= 2 ? policy.deniedOptions : [];
  if (version >= 2 && (!Array.isArray(deniedOptions) || version === 2 && !deniedOptions.length || deniedOptions.length > 32
    || new Set(deniedOptions).size !== deniedOptions.length
    || deniedOptions.some(option => typeof option !== 'string' || !/^--[a-z][a-z0-9-]{0,63}$/u.test(option))))
    fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
  const readOnly = new Set();
  if (version >= 3) {
    if (!Array.isArray(policy.readOnlyCommands) || policy.readOnlyCommands.length > seen.size)
      fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
    for (const prefix of policy.readOnlyCommands) {
      // Declaring an effect cannot admit an otherwise forbidden command. Each
      // entry must repeat one of the already validated literal task prefixes.
      const key = JSON.stringify(prefix);
      if (!seen.has(key) || readOnly.has(key)) fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
      readOnly.add(key);
    }
  }
  const localArtifact = new Set();
  if (version === 4) {
    if (!Array.isArray(policy.localArtifactCommands) || policy.localArtifactCommands.length > seen.size)
      fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
    for (const prefix of policy.localArtifactCommands) {
      const key = JSON.stringify(prefix);
      if (!seen.has(key) || readOnly.has(key) || localArtifact.has(key)) fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID');
      localArtifact.add(key);
    }
  }
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
    || runtimeArguments.some(arg => deniedOptions.some(option => arg === option || arg.startsWith(`${option}=`))))
    fail('ASSISTANT_SKILL_COMMAND_DENIED');
  const matches = policy.taskCommands.filter(prefix => assistantTaskPrefixMatches(prefix, runtimeArguments));
  if (!matches.length) fail('ASSISTANT_SKILL_COMMAND_DENIED');
  // A more general read-only prefix never overrides an overlapping command
  // whose effects were not reviewed. Legacy declarations still admit the
  // exact same commands and give no positive evidence about their effects.
  if(matches.every(prefix => readOnly.has(JSON.stringify(prefix))))return 'read_only';
  if(matches.every(prefix => localArtifact.has(JSON.stringify(prefix))))return 'local_artifact';
  return 'unknown';
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
export const readSkillSecretSetupCommands = parsedPackage =>
  structuredClone(readSkillSetupDescriptor(parsedPackage)?.commands.filter(command=>command.purpose==='authenticate')??[]);
export const readSkillSecretSetupCommand = (parsedPackage, runtimeArguments) =>
  readSkillSetupDescriptor(parsedPackage)?.commands.find(command => JSON.stringify(command.arguments) === JSON.stringify(runtimeArguments)) ?? null;

/** A native-owned ID selects exact signed argv; no caller argv, Secret field,
 * environment override or registration purpose is accepted by this reader. */
export const readSkillHumanInputSetupCommands = parsedPackage =>
  structuredClone(readSkillSetupDescriptor(parsedPackage)?.humanInputCommands ?? []);
export const readSkillHumanInputSetupCommand = (parsedPackage, commandId) =>
  readSkillHumanInputSetupCommands(parsedPackage).find(command => command.id === commandId) ?? null;

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
