import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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

// Closed compatibility for the public court skill v4.1.11, source
// 0ff72394067c18b964d06d9ffe565c5875e8c79b. This policy interprets a
// retained original; never expose these commands to the live executor.
const historicalCourtRelease = Object.freeze({skillId:'gas-pravosudie',
  releaseId:'d4f7679b-a03d-4e42-9d48-37a4688b95e2', packageSha256:'32e6733b6e6e948a0fb8e27018a8788121f0e18f72f118d5c18d229fb906ed7e'});
const historicalCourtGuides = [
  'a1b587718a626a15fd348441258370ee6d399ee667ab86705c93156039a2e191',
  '93cde8edb268dd514280eb7a0cc9fffc41cb73e16278ff116763afe1991fc2a1',
  'e559cf1eacc47d46b1e0da6270987443ea6c60f834c13c1e8439761cba45d7b3',
  '7f4acf3142038cb5db27fad4f4580c8f97a4c6c36e37a5d73c51589057abd59f',
];
const historicalCourtUuid = value => typeof value === 'string'
  && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);

// A court browser can do much more than inspect a case. Do not take a page
// result or the provider's blacklist as generic proof of read-only navigation.
// This is the official public card selector, with a closed set of query fields.
const publicCourtCaseOrigin = value => {
  if (typeof value !== 'string' || value.length > 1024 || /[^!-~]|[%#@\\]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.href !== value || url.protocol !== 'https:' || url.port || url.username || url.password
    || !/^(?:[a-z0-9-]+\.)+sudrf\.ru$/u.test(url.hostname) || url.pathname !== '/modules.php') return null;
  const q = url.searchParams;
  if (q.size !== 6 || q.get('name') !== 'sud_delo' || q.get('name_op') !== 'case'
    || !historicalCourtUuid(q.get('case_uid'))
    || !['srv_num','case_id','delo_id'].every(key => /^[0-9]{1,20}$/u.test(q.get(key) ?? ''))) return null;
  return url.origin;
};

const courtSelection = (value, scope, runtimeSessionId) => {
  const skill = value?.skill, release = skill?.runtimeRelease, execution = value?.runtimeExecution;
  const selected = execution?.localAction?.arguments?.parameters;
  return skill?.id === historicalCourtRelease.skillId && skill.version === '4.1.11'
    && release?.releaseId === historicalCourtRelease.releaseId && release.packageSha256 === historicalCourtRelease.packageSha256
    && release.trustLevel === 'platform_verified' && release.runtimeVersion === '1.0.16'
    && execution?.releaseId === release.releaseId && selected?.releaseId === release.releaseId
    && selected.skillId === skill.id && selected.companyId === scope.companyId && historicalCourtUuid(selected.projectId)
    && historicalCourtUuid(runtimeSessionId) && selected.runtimeSessionId === runtimeSessionId ? selected : null;
};

const retainedCourtGuide = (value, page, parameters) => {
  const part = parameters.guidePart ?? 0, next = part === 3 ? null : part + 1;
  if (!Number.isInteger(part) || part < 0 || part > 3 || page?.schemaVersion !== 1
    || page.part !== part || page.count !== 4 || page.nextGuidePart !== next
    || !['instruction-guides/', 'scripts/instruction-guides/'].some(dir => page.path === dir+'part-0'+(part+1)+'.md')
    || page.sha256 !== historicalCourtGuides[part] || typeof page.text !== 'string'
    || crypto.createHash('sha256').update(page.text).digest('hex') !== page.sha256
    || !exactKeys(value,['schemaVersion','operation','stdout','instruction','nextCall'])
    || typeof value.instruction !== 'string' || Buffer.byteLength(value.instruction) > 512) return false;
  const expected = next === null ? null : {tool:'continue_assistant_workspace_action',
    arguments:{schemaVersion:1,operation:'skill_run',parameters:{...parameters,guidePart:next}}};
  return isDeepStrictEqual(value.nextCall,expected);
};

/** The caller checks the remaining items in the frozen native turn independently.
 * Bind each provider call to the preceding original native selection, exact
 * pass, project, session and immutable artifact. Browser lifecycle and local
 * session storage can be settled only by a positive close of this same visit.
 * Nothing in this classifier grants another attempt, even on a parser error. */
export const reviewedHistoricalOwnerAnswerSkills = (items, taskPass) => {
  if (!Array.isArray(items)) return false;
  if (!items.some(item => item?.tool === 'continue_assistant_workspace_action' && item.arguments?.operation === 'skill_run')) return true;
  let selected = null, sessionId = null, ready = false, caseOrigin = null;
  const skill = historicalCourtRelease.skillId;
  for (const item of items) {
    const args = item?.arguments;
    const selection = item?.tool === 'get_agent_skill' && args?.skillId === skill;
    if (!selection && !(item?.tool === 'continue_assistant_workspace_action' && args?.operation === 'skill_run')) continue;
    const result = item.result, value = result?.structuredContent, proofSessionId = args.runtimeSessionProof?.runtimeSessionId;
    if (item.type !== 'mcpToolCall' || item.server !== 'trelio-assistant' || item.error != null || result?._meta != null
      || !exactKeys(args.taskPass,['companyId','taskId','passId'])
      || !['companyId','taskId','passId'].every(key => historicalCourtUuid(taskPass?.[key]) && args.taskPass[key] === taskPass[key])
      || !historicalCourtUuid(proofSessionId)) return false;
    if (result?.isError != null && typeof result.isError !== 'boolean') return false;
    const positive = item.status === 'completed' && result?.isError !== true;
    if (selection) {
      if (!positive || sessionId || !(selected = courtSelection(value,taskPass,proofSessionId))) return false;
      continue;
    }
    const p = args.parameters, base = ['companyId','projectId','skillId','releaseId','runtimeSessionId','arguments'];
    if (!selected || args.schemaVersion !== 1 || !exactKeys(args,['schemaVersion','operation','parameters','taskPass','runtimeSessionProof'])
      || !(exactKeys(p,base) || exactKeys(p,[...base,'guidePart'])) || !Array.isArray(p.arguments)
      || p.arguments.length > 7 || p.arguments.some(x => typeof x !== 'string' || x.length > 1024)
      || proofSessionId !== selected.runtimeSessionId || !base.slice(0,-1).every(key => selected[key] === p[key])) return false;
    const argv = p.arguments, cmd = argv[0], is = (...tokens) => isDeepStrictEqual(argv,tokens);
    if (cmd !== 'guides' && Object.hasOwn(p,'guidePart')) return false;
    if (!positive) {
      // parseArguments checks an unknown command/option BEFORE host setup,
      // private storage and browser I/O. A failure on any other argv remains
      // unknown even if the generic native error code is identical.
      const code = 'TRELIO_WORKSPACE_ACTION_FAILED';
      if (!(is('--help') || is('page','--help')) || item.status !== 'failed' || result?.isError === false
        || !exactKeys(value,['code']) || value.code !== code || !isDeepStrictEqual(result.content,[{type:'text',text:code}])) return false;
      continue;
    }
    if (value?.schemaVersion !== 1 || value.operation !== 'skill_run' || typeof value.stdout !== 'string'
      || Buffer.byteLength(value.stdout) > 65_536) return false;
    let output;
    try { output = JSON.parse(value.stdout); } catch { return false; }
    if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
    if (is('guides')) {
      if (!retainedCourtGuide(value,output,p)) return false;
      continue;
    }
    if (!exactKeys(value,['schemaVersion','operation','stdout'])) return false;
    if (is('doctor')) {
      if (output.runtimeVersion !== '1.0.16' || output.osPrompt !== false || typeof output.runtimeReady !== 'boolean') return false;
    } else if (is('start')) {
      // Reusing an already-running lease has a different signed result. Only
      // the freshly started isolated browser has both this action and exact
      // wait selector; no authorization or foreground user action is covered.
      if (sessionId || output.phase !== 'starting' || !historicalCourtUuid(output.sessionId)
        || output.requiredAction !== 'Дождитесь ready; браузер откроется без активации окна.'
        || !isDeepStrictEqual(output.continuation,{arguments:['wait','--session',output.sessionId,'--after-phase','starting','--timeout-seconds','30']})) return false;
      sessionId = output.sessionId;
    } else if (!sessionId) return false;
    else if (is('wait','--session',sessionId,'--after-phase','starting','--timeout-seconds','30')) {
      if (ready || output.sessionId !== sessionId || output.phase !== 'ready' || output.requiredAction !== null
        || !isDeepStrictEqual(output.wait,{changed:true,timedOut:false}) || Object.hasOwn(output,'error')) return false;
      ready = true;
    } else if (ready && is('page','--session',sessionId,'--navigate',argv[4])) {
      if (!(caseOrigin = publicCourtCaseOrigin(argv[4])) || !isDeepStrictEqual(output,{ok:true})) return false;
    } else if (ready && is('snapshot','--session',sessionId)) {
      if (!caseOrigin || output.origin !== caseOrigin || output.truncated !== true
        || typeof output.text !== 'string' || !Array.isArray(output.controls) || output.controls.length > 400) return false;
    } else if (is('stop','--session',sessionId)) {
      if (!isDeepStrictEqual(output,{phase:'closed',sessionId})) return false;
      sessionId = null; ready = false; caseOrigin = null;
    } else return false;
  }
  return sessionId === null;
};

const historicalEmailRelease = Object.freeze({skillId:'email-imap-smtp',
  releaseId:'353b28f3-8c94-4d69-a287-5f66ae953484',
  packageSha256:'ef3374b49e7e5cc09330515fac6d97ec8579d64591da09726d89ad9610f238cb'});
// Retained platform v2.9.3 (0b5a5a8698a41c9121a94b5315efbc18ccee3c14)
// already attests reads. Its export uses read-only IMAP and exclusive file
// creation but predates a signed local-artifact declaration for that command.
const historicalEmailExportRelease = Object.freeze({skillId:'email-imap-smtp',
  releaseId:'a15e4540-4c58-42b4-b64e-d5c6a375445b',
  packageSha256:'19d8bf1145b7e73b87adb452c7036db7787cee3e8f1560b4f20ac8dabdeba865'});

// This immutable predecessor's account inventory and guide/diagnostic
// commands were audited with its archive command. Reuse the observations
// across recovery modes, but never classify its export as a read.
const historicalEmailMetadataRead = (arguments_,accountId) => {
  const [command,option]=arguments_;
  if(accountId===null)return arguments_.length===2&&command==='account'&&option==='list';
  return arguments_.length===1&&['guides','doctor','folders'].includes(command)
    ||arguments_.length===2&&command==='policy'&&option==='show';
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
},{
  ...historicalEmailRelease,terminalOnly:true,accepts:historicalEmailMetadataRead,
}];
export const reviewedAssistantHistoricalSkillRead = ({skillId,releaseId},{providerArguments,accountId},{terminal=false}={})=>{
  const policy=historicalTaskSkillReads.find(row=>row.skillId===skillId&&row.releaseId===releaseId);
  if(!policy||policy.terminalOnly&&!terminal||!policy.accepts(providerArguments,accountId))return null;
  return {skillId,releaseId,packageSha256:policy.packageSha256};
};

/** Compatibility for one pre-receipt package in native draft preservation.
 * The live catalogue attests this immutable package and the server rechecks
 * its digest and publication. The regular task executor never uses this audit.
 *
 * Source 205892438b5d773e3be424a3c4cad80e6af717d0: doctor disables SMTP repair,
 * SEARCH and FETCH use read-only IMAP selection/BODY.PEEK, and save-message
 * writes a single exclusive RFC822 file. Its stdout is only a claim until
 * the common verifier finds the same bytes in the selected draft or local delta.
 */
export const reviewedHistoricalCheckpointSkill = ({skillId,releaseId},{providerArguments,accountId},stdout) => {
  const [command,...tail]=providerArguments;
  const release=releaseId===historicalEmailExportRelease.releaseId&&command==='save-message'
    ?historicalEmailExportRelease:historicalEmailRelease;
  if(skillId!==release.skillId||releaseId!==release.releaseId)return null;
  if(historicalEmailMetadataRead(providerArguments,accountId))return {release};
  if(accountId===null)return null;
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

/** Decode the reviewed predecessor of a typed outbound-delivery receipt.
 * Its preview was never an effect. The exact attempt and an independently
 * read Sent object must match. When the caller requires a positive reply,
 * the signed command's verified Sent copy selects that object directly.
 * The archive still needs immutable-byte and reply-header verification in the
 * owning Run. Unsupported commands or additional attempts remain unresolved.
 */
export const inspectHistoricalTaskDelivery = (calls,{scope,startedAt,completedAt,requireAcceptedReply=false}) => {
  if(!Array.isArray(calls)||calls.length<5||calls.length>32
    ||!Number.isSafeInteger(startedAt)||startedAt<=0)return null;
  // Native interrupted turns can have no completedAt. Bound the receipt date
  // to the original execution window; its later search/read/export order is
  // proven by the complete native history, not by the email's Date header.
  const windowEnd=completedAt??Math.min(startedAt+1800,Math.floor(Date.now()/1000));
  if(!Number.isSafeInteger(windowEnd)||windowEnd<startedAt||windowEnd-startedAt>1800)return null;
  let accountBinding,preview,attempt,sent,observed,delivery;
  for(const {parameters,stdout,failure} of calls){
    if(parameters?.companyId!==scope.companyId||parameters.skillId!==historicalEmailRelease.skillId
      ||parameters.releaseId!==historicalEmailRelease.releaseId||!Array.isArray(parameters.arguments)
      ||parameters.arguments.length>20||parameters.arguments.some(arg=>typeof arg!=='string'||Buffer.byteLength(arg)>16*1024))return null;
    let parsed,result;
    try{
      parsed=splitAccountArguments(parameters.arguments);
      if(!failure){
        if(typeof stdout!=='string'||Buffer.byteLength(stdout)>65_536)return null;
        result=JSON.parse(stdout);
      }else if(failure!=='ASSISTANT_WORKSPACE_OUTCOME_REVIEW_REQUIRED')return null;
    }catch{return null;}
    const {accountId,providerArguments}=parsed;
    if(!accountId)return null;
    // Account IDs live in the selected local scope. Keep the positive read
    // and archived copy bound to the same project and observed session as
    // the earlier attempt, even when another account has the same mailbox.
    const binding=canonicalJson([accountId,parameters.projectId??null,parameters.runtimeSessionId]);
    if(accountBinding&&accountBinding!==binding)return null;
    accountBinding=binding;
    const [command,...rest]=providerArguments;
    if(['policy','signature'].includes(command)&&rest.length===1&&rest[0]==='show'&&!failure)continue;
    const options=new Map();
    // This parser is private to the audited old command vectors. It cannot
    // execute them or reinterpret an unknown option as a harmless read.
    const keys=command==='reply'?['--folder','--uid','--body','--expected-plan-sha256']
      :command==='search'?['--folder','--special-use','--since','--limit','--from','--to','--subject','--before']
      :command==='read'?['--folder','--uid']:command==='save-message'?['--folder','--uid','--output']:null;
    if(!keys)return null;
    for(let index=0;index<rest.length;index++){
      const key=rest[index];
      if(options.has(key))return null;
      if(command==='reply'&&key==='--confirm'){options.set(key,true);continue;}
      const value=rest[++index];
      if(!keys.includes(key)||typeof value!=='string'||!value||value.startsWith('--')||value.includes('\0'))return null;
      options.set(key,value);
    }
    const folder=options.get('--folder'),uid=options.get('--uid');
    if(command==='search'){
      if(Boolean(folder)===options.has('--special-use')||!/^\d{4}-\d{2}-\d{2}$/u.test(options.get('--since')??'')
        ||!/^([1-9]|[1-9][0-9]|100)$/u.test(options.get('--limit')??''))return null;
      // A timed-out audited SEARCH cannot have delivered another message.
      if(!requireAcceptedReply&&!failure&&attempt&&options.get('--special-use')==='sent'&&accountId===preview?.accountId){
        if(sent||!Array.isArray(result?.messages)||result.messages.length!==1||typeof result.folder!=='string')return null;
        sent={...result.messages[0],folder:result.folder};
      }
      continue;
    }
    if(!folder||!/^[1-9][0-9]{0,9}$/u.test(uid??''))return null;
    if(command==='reply'){
      const identity=[accountId,parameters.projectId??null,parameters.runtimeSessionId,folder,uid,options.get('--body')];
      if(typeof identity[5]!=='string'||delivery)return null;
      if(!options.has('--confirm')){
        const plan=result?.plan;
        if(preview||attempt||failure||options.size!==3||result?.prepared!==true||result.sent!==false
          ||!/^[a-f0-9]{64}$/u.test(result.planSha256??'')||plan?.source?.folder!==folder||plan.source.uid!==uid
          ||typeof plan.source.messageId!=='string'||!/^<[^<>\s]{1,512}>$/u.test(plan.source.messageId)
          ||typeof plan.subject!=='string'||typeof plan.body!=='string'||typeof plan.from!=='string'
          ||!Array.isArray(plan.to)||!plan.to.length||!Array.isArray(plan.cc)
          ||![...plan.to,...plan.cc].every(address=>typeof address==='string'&&address.length<512)
          ||!Array.isArray(plan.attachments)||plan.attachments.length)return null;
        preview={identity,accountId,plan,planSha256:result.planSha256};
      }else{
        const hasExpectedReceipt=requireAcceptedReply?!failure:Boolean(failure);
        if(!preview||attempt||!hasExpectedReceipt||options.size!==5
          ||preview.planSha256!==options.get('--expected-plan-sha256')
          ||JSON.stringify(identity)!==JSON.stringify(preview.identity))return null;
        if(requireAcceptedReply){
          const copy=result?.sentCopy;
          if(result?.sent!==true||result.smtpStatus!=='accepted'||result.planSha256!==preview.planSha256
            ||!Array.isArray(result.refusedRecipients)||result.refusedRecipients.length
            ||copy?.saved!==true||copy.verified!==true||typeof copy.folder!=='string'||!copy.folder
            ||!/^<[^<>\s]{1,512}>$/u.test(result.messageId??'')||!/^[1-9][0-9]{0,9}$/u.test(copy.uid??''))return null;
          sent={folder:copy.folder,uid:copy.uid,messageId:result.messageId};
        }
        attempt=assistantTaskSkillReadRequestDigest(scope,parameters);
      }
      continue;
    }
    if(failure)return null;
    if(!attempt||!sent||accountId!==preview.accountId||folder!==sent.folder||uid!==sent.uid){
      // The root can have ordinary incoming-mail reads before or after its
      // confirmed send. Only the selected verified Sent UID is evidence.
      if(requireAcceptedReply&&command==='read'
        &&reviewedHistoricalCheckpointSkill(parameters,parsed,stdout))continue;
      return null;
    }
    if(command==='read'){
      const body=value=>value.replace(/\r\n/gu,'\n').replace(/\n$/u,'');
      const date=Date.parse(result?.date),{plan}=preview;
      if(observed||options.size!==2||result?.folder!==folder||result.uid!==uid||result.messageId!==sent.messageId
        ||!/^<[^<>\s]{1,512}>$/u.test(result.messageId??'')||date<startedAt*1000||date>windowEnd*1000||!Number.isFinite(date)
        ||typeof result.body!=='string'||body(result.body)!==body(plan.body)||result.subject!==plan.subject
        ||result.from!==plan.from||result.to!==plan.to.join(', ')||result.cc!==plan.cc.join(', ')
        ||!Array.isArray(result.attachments)||result.attachments.length||!/^[a-f0-9]{64}$/u.test(result.originalSha256??''))return null;
      observed=result;
      continue;
    }
    const retained=reviewedHistoricalCheckpointSkill(parameters,parsed,stdout);
    if(delivery||!observed||!retained?.artifact||retained.artifact.contentSha256!==observed.originalSha256)return null;
    // Keep identities private. Only the exact archived RFC822 object may use
    // this receipt and its bound comparison keys when checking the saved Run.
    delivery={attemptSha256:attempt,artifact:retained.artifact,release:retained.release,
      replyHeaderSha256:crypto.createHash('sha256').update(canonicalJson([observed.messageId,preview.plan.source.messageId])).digest('hex')};
  }
  return delivery??null;
};

export const matchesHistoricalReplyHeaders = (bytes,expected) => {
  // A complete, bound RFC822 object must carry one Message-ID and one
  // In-Reply-To. Their equality with the observed Sent object and original
  // reviewed source is checked locally, never from a model-visible label.
  const match=/\r?\n\r?\n/u.exec(bytes.subarray(0,16*1024).toString('latin1'));
  if(!match)return false;
  const fields=bytes.subarray(0,match.index).toString('latin1').replace(/\r?\n[ \t]+/gu,' ').split(/\r?\n/u);
  const pair=['message-id','in-reply-to'].map(name=>{
    const rows=fields.filter(line=>line.toLowerCase().startsWith(`${name}:`));
    return rows.length===1?rows[0].slice(name.length+1).trim():null;
  });
  return pair.every(id=>/^<[^<>\s]{1,512}>$/u.test(id??''))
    &&crypto.createHash('sha256').update(canonicalJson(pair)).digest('hex')===expected;
};

// Source monitor/ACK/reply/media operations have their own native admission
// and attempt records. An ordinary task must never address those entry points
// directly, even if its signed provider also implements them.
const nativeSourceCommands = new Set([
  'monitor', 'ack-reference', 'source-original', 'reply-reference', 'unsubscribe-reference',
]);
const visualAccountCommands = new Set(['disconnect', 'show-login', 'credentials-setup', 'credentials-forget']);

/** Ordinary skills use their published CLI under the existing native task and
 * account admission. A signed policy can still restrict its own release and
 * attest command effects. Missing metadata supplies neither an effect witness
 * nor access to an internal host or protected account operation.
 */
export const assertAssistantTaskSkillCommand = (parsedPackage, runtimeArguments) => {
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  if (!Array.isArray(runtimeArguments) || !runtimeArguments.length
    || runtimeArguments.some(argument => typeof argument !== 'string'))
    fail('ASSISTANT_SKILL_COMMAND_DENIED');
  const [command] = runtimeArguments;
  if (!command || command.startsWith('__trelio_') || nativeSourceCommands.has(command)
    || parsedPackage.browserSession?.sessionClass === 'protected-snapshot' && visualAccountCommands.has(command))
    fail('ASSISTANT_SKILL_COMMAND_DENIED');

  let setup;
  try { setup = readSkillSetupDescriptor(parsedPackage); }
  catch { fail('ASSISTANT_SKILL_COMMAND_POLICY_INVALID'); }
  // These exact signed operations use a separate native one-use owner grant.
  // Check before any ordinary package can select its account or interpreter.
  const protectedCommands = [...(setup?.commands ?? []), ...(setup?.humanInputCommands ?? [])];
  if (protectedCommands.some(({arguments: declared}) =>
    declared.length === runtimeArguments.length && assistantTaskPrefixMatches(declared, runtimeArguments)))
    fail('ASSISTANT_SKILL_COMMAND_DENIED');

  const files = parsedPackage.files.filter(file => file.path === 'trelio-assistant-execution.json');
  if (!files.length) return 'unknown';
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
  // Match the publisher's literal protected options without interpreting the
  // provider parser. Both the separate value and equals spelling are denied.
  if (runtimeArguments.some(argument => deniedOptions.some(option =>
    argument === option || argument.startsWith(`${option}=`))))
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
