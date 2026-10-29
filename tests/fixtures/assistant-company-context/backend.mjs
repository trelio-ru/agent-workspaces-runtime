/** Synthetic native/backend data for the composed owner-company scenario.
 * All crypto is the production codec. The server owns only generated UUIDs,
 * disposable fixture keys and synthetic text; no company/account is imported.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,webcrypto,verify,createPublicKey,createHash} from 'node:crypto';
import {hpkeSeal,encryptCompanyPayload,buildCompanyEncryptedTextMarker,encryptFileToCompanyContainer} from '../../../host-runtime/scripts/trelio-company-encryption.mjs';

export const startCompanyScenarioBackend=async({identity,pass,credential,runtimePublicKey,root,fileCount=0,stallAttempts=0,refuse=false,unknownCode=false})=>{
  assert.ok(Number.isInteger(fileCount)&&fileCount>=0&&fileCount<=3000);
  const scopeId=randomUUID(),cryptoDeviceId=randomUUID(),projectId=randomUUID(),taskId=randomUUID();
  const projectSlug=`e-${projectId}`,company={id:pass.companyId,slug:'synthetic',name:'Synthetic fixture company'};
  const origin={companyId:pass.companyId,sourceId:pass.sourceId,intakeId:pass.passId};
  const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
  const projectAad={companyId:company.id,scopeId,scopeEpoch:1,entityType:'project',entityId:projectId,entityRevision:1,schemaVersion:1,purpose:'content'};
  const taskAad={...projectAad,entityType:'task',entityId:taskId};
  const payloads=[{...projectAad,...await encryptCompanyPayload({scopePublicEncryptionJwk:publicJwk,aad:projectAad,
    payload:{values:{title:'Synthetic private project',rules:'Synthetic complete rules'}}})},
    {...taskAad,...await encryptCompanyPayload({scopePublicEncryptionJwk:publicJwk,aad:taskAad,
      payload:{values:{title:'Synthetic weekend journey',description:'OLD_SYNTHETIC_DESCRIPTION',current:'CURRENT_SYNTHETIC_PLAN'}}})}];
  const marker=(id,field)=>buildCompanyEncryptedTextMarker(id,field),project={id:projectId,slug:projectSlug,name:marker(projectId,'title'),isArchived:false};
  const instructions={company:{compiledMarkdown:marker(projectId,'rules')},projects:[],userProfile:null};
  const manifest={schemaVersion:2,provider:'local_company_context',generation:'a'.repeat(64),company,
    viewer:{memberId:randomUUID(),companyRole:'admin'},viewerGroupIds:[],projects:[project],
    tasks:[{id:taskId,projectId,projectSlug,number:1,title:marker(taskId,'title'),revisionToken:'b'.repeat(64)}],
    acceptedWorkspaces:[],workspaces:[],contextDocuments:[],
    searchDocuments:[{id:`task:synthetic/${projectSlug}/1`,type:'task',title:marker(taskId,'title'),
      stableKey:`synthetic/${projectSlug}/1/task`,referenceValues:[taskId],revisionToken:'b'.repeat(64),
      fields:[{source:'title',values:[marker(taskId,'title')]}],metadata:{projectId,projectSlug,taskNumber:1}}],
    instructions,agentSkills:{company:[],projects:[]},agentProcedures:[]};
  let managed,envelope,mode='ready',closed=false,healthRevision=1;
  const workspaceId=randomUUID(),workspaceHead='c'.repeat(40),projectionId=randomUUID(),manifestFileId=randomUUID();
  const containers=new Map(),fileIds=[],hits=new Map();
  const counts={nativeAdmissions:0,manifests:0,exact:0,current:0,mutations:0,fileReads:0,ciphertextBytes:0,builds:0},proofs=new Set(),failures=[];
  const verifyProof=(proof,toolName)=>{
    assert.equal(proof.schemaVersion,1);assert.ok(!proofs.has(proof.nonce),'one native request consumes one fresh proof');
    const signed=Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,toolName,proof.issuedAt,proof.nonce].join('\n'));
    assert.equal(verify(null,signed,createPublicKey(runtimePublicKey),Buffer.from(proof.signature,'base64url')),true);
    proofs.add(proof.nonce);
  };
  const json=(response,value,status=200)=>{response.statusCode=status;response.setHeader('content-type','application/json');response.end(JSON.stringify(value));};
  const descriptor=name=>({schemaVersion:1,nativeTool:name,companyId:company.id,companySlug:company.slug,intakePass:origin,
    assistantUserId:identity.assistantId,deviceId:identity.deviceId,requestOrigin:'https://e2ee.trelio.ru'});
  const leaseExpiresAt=new Date(Date.now()+30*60_000).toISOString();
  const intake=()=>({schemaVersion:1,id:pass.passId,companyId:company.id,sourceId:pass.sourceId,sourceRevision:pass.sourceRevision,
    eventId:pass.eventId,threadId:pass.threadId,state:closed?'cancelled':'leased',leaseExpiresAt,
    taskId:null,receiptId:null,readConfirmed:true,ownerPrivateRead:true,execution:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1}});
  const schema=properties=>({type:'object',anyOf:[{type:'object',properties:{...properties,intakePass:{},runtimeSessionProof:{}},
    required:[...Object.keys(properties),'intakePass','runtimeSessionProof'],additionalProperties:false},
    {type:'object',properties:{localContextRead:{const:true,type:'boolean'},intakePass:{},runtimeSessionProof:{}},
      required:['localContextRead','intakePass','runtimeSessionProof'],additionalProperties:false}]});
  const tools=[{name:'get_assistant_status',description:'Synthetic native status',inputSchema:{type:'object',properties:{view:{type:'string'}},additionalProperties:true}},
    {name:'search',description:'Synthetic native company search',inputSchema:schema({queries:{type:'array',items:{type:'string'}}})},
    {name:'fetch',description:'Synthetic native exact source',inputSchema:schema({id:{type:'string'}})},
    {name:'get_task_activity',description:'Synthetic current discussion',inputSchema:schema({companySlug:{type:'string'},projectSlug:{type:'string'},taskNumber:{type:'integer'}})},
    ...['get_assistant_intake_context','resolve_assistant_intake'].map(name=>({name,description:'Synthetic owner lifecycle',inputSchema:{type:'object'}}))];
  const server=createServer(async(request,response)=>{
    try{
      assert.equal(request.headers.authorization,`Bearer ${credential}`,'only the synthetic device credential is valid');
      const chunks=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;assert.ok(bytes<1024*1024);chunks.push(chunk);}
      const body=bytes?JSON.parse(Buffer.concat(chunks).toString('utf8')):null;
      const selected=new URL(request.url,'http://127.0.0.1');
      if(selected.pathname.startsWith('/api/digital-assistants/runtime/workspace/')
        ||selected.pathname==='/api/digital-assistants/runtime/encryption/runtime'){
        // Independent native boundary: fixed read-only proof vocabulary and
        // exact original intake, not the client route classifier calling itself.
        assert.deepEqual(JSON.parse(request.headers['x-trelio-assistant-pass']),{kind:'source_intake',...origin});
        verifyProof(JSON.parse(request.headers['x-trelio-assistant-proof']),'assistant_workspace_data_plane_read');
      }
      if(selected.pathname==='/mcp/assistant'){
        response.setHeader('mcp-session-id','synthetic-company-session');
        if(request.method==='DELETE'||body?.method==='notifications/initialized'){response.statusCode=204;response.end();return;}
        const reply=result=>json(response,{jsonrpc:'2.0',id:body.id,result});
        if(body.method==='initialize'){reply({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'synthetic native backend',version:'1'}});return;}
        if(body.method==='tools/list'){reply({tools});return;}
        assert.equal(body.method,'tools/call');
        const {name,arguments:args}=body.params;
        if(name==='get_assistant_status'){reply({content:[],structuredContent:{companyContextRead:true,presentationProfile:'company_context'}});return;}
        assert.ok(['search','fetch','get_task_activity'].includes(name),'no task/Workspace write is part of a company question');
        assert.deepEqual(args.intakePass,origin);assert.equal(args.localContextRead,true);
        verifyProof(args.runtimeSessionProof,name);counts.nativeAdmissions++;
        assert.ok(!JSON.stringify(args).includes('weekend'),'the original company query stays local');
        reply({isError:true,content:[],structuredContent:{code:'ASSISTANT_ENCRYPTED_COMPANY_READ_REQUIRED',localRead:descriptor(name)}});return;
      }
      if(selected.pathname.endsWith('/source-skills/intake/read')){assert.deepEqual(body,origin);json(response,intake());return;}
      if(selected.pathname.endsWith('/runtime/health')){
        // The real worker reports contact after a successful read. This is a
        // diagnostic CAS, not a task mutation; no unrelated latch may clear.
        if(request.method==='POST'){
          assert.equal(body.code,'ready');assert.equal(body.expectedRevision,healthRevision);
          assert.equal(body.clearedReason,undefined);healthRevision++;
        }else assert.equal(request.method,'GET');
        json(response,{revision:healthRevision,generation:1,code:'ready',latchedCodes:[],
          compatibility:{minimumPluginVersion:'0.0.0',minimumRuntimeVersion:'0.0.0'}});return;
      }
      if(selected.pathname.endsWith('/bridge-compatibility')){
        const rulesMarkdown='Synthetic complete platform rules\n',sha256=createHash('sha256').update(rulesMarkdown).digest('hex');
        json(response,{supported:true,minimumVersion:'0.0.0',encryptedDataPlane:{enabled:true,routingVersion:1},
          agentRules:{status:request.headers['x-trelio-agent-rules-sha256']===sha256?'current':'update_required',
            revisionId:scopeId,version:1,sha256,rulesMarkdown}});return;
      }
      if(selected.pathname.endsWith('/runtime/companies')){
        json(response,{assistantUserId:identity.assistantId,bindingId:identity.deviceId,
          companies:[{id:company.id,memberId:manifest.viewer.memberId,slug:company.slug,encryptionState:'encrypted'}]});return;
      }
      if(selected.pathname.endsWith('/bridge-routing')){json(response,{schemaVersion:1,company,encryptionState:'encrypted',encryptedDataPlaneOrigin:'https://e2ee.trelio.ru'});return;}
      if(selected.pathname.endsWith('/runtime/encryption/runtime')){
        if(mode==='recipient_revoked'){json(response,{code:'ACCESS_DENIED',message:'SYNTHETIC_PRIVATE_REFUSAL_CANARY'},403);return;}
        const found=managed&&selected.searchParams.get('fingerprint')===managed.fingerprint;
        json(response,{state:'encrypted',suite:'trelio-e2ee-v1',company,viewer:{userId:identity.assistantId},accessState:found?'ready':'device_required',
          device:found?{id:cryptoDeviceId,fingerprint:managed.fingerprint}:null,scope:found?{id:scopeId,epoch:1,publicEncryptionJwk:publicJwk}:null,
          envelope:found?{...envelope,...(mode==='recipient_changed'?{id:randomUUID()}: {})}:null});return;
      }
      assert.equal(request.headers['x-trelio-assistant-encryption-device'],cryptoDeviceId,
        `synthetic route requires its current managed recipient: ${selected.pathname}`);
      const binary=/\/files\/([0-9a-f-]+)\/encrypted-content$/u.exec(selected.pathname);
      if(binary){
        const bytes=containers.get(binary[1]);assert.ok(bytes,'only accepted synthetic projection files are readable');
        const index=fileIds.indexOf(binary[1]);hits.set(index,(hits.get(index)??0)+1);
        if(index>=8&&counts.builds<=stallAttempts){
          // A genuine pending HTTP body is aborted by the SAME original
          // private-session deadline. Observe disconnect; do not fake a timeout
          // DTO, replace the operation, or leave an owned listener hanging.
          await new Promise(resolve=>response.once('close',resolve));return;
        }
        counts.fileReads++;response.setHeader('content-type','application/octet-stream');
        response.setHeader('x-trelio-workspace-id',workspaceId);response.setHeader('x-trelio-workspace-head',workspaceHead);
        response.setHeader('x-trelio-ciphertext-sha256',createHash('sha256').update(bytes).digest('hex'));
        response.end(bytes);return;
      }
      if(selected.pathname.endsWith(`/workspaces/${workspaceId}`)){
        counts.builds++;
        if(refuse){json(response,{code:unknownCode?'SYNTHETIC_PRIVATE_REFUSAL_CANARY':'ACCESS_DENIED',message:'SYNTHETIC_PRIVATE_REFUSAL_CANARY'},403);return;}
        json(response,{schemaVersion:1,encryptedPayloads:[],context:{company,workspace:{id:workspaceId,acceptedHead:workspaceHead},
          encryption:{browserProjection:{id:projectionId,manifestFileId,workspaceHead,fileCount}}}});return;
      }
      if(selected.pathname.endsWith(`/company-context/${company.slug}/manifest`)){counts.manifests++;json(response,{schemaVersion:1,context:manifest,encryptedPayloads:payloads});return;}
      if(selected.pathname.endsWith(`/company-context/${company.slug}/tasks/${projectSlug}/1`)){
        counts.exact++;assert.equal(request.method,'GET');
        assert.equal(selected.searchParams.get('expectedRevision'),'b'.repeat(64));
        json(response,{schemaVersion:1,encryptedPayloads:payloads,context:{schemaVersion:1,revisionToken:'b'.repeat(64),
          task:{company,project,task:{id:taskId,number:1,title:marker(taskId,'title'),descriptionPlainText:marker(taskId,'description'),
            status:{code:'active',name:'Active'},participants:[],controls:[],comments:[],checklists:[]}},connections:{},relatedWorkspaces:[]}});return;
      }
      if(selected.pathname.endsWith('/tasks/read')){
        counts.exact++;assert.deepEqual(body.tasks,[{projectSlug,taskNumber:1}]);
        json(response,{schemaVersion:1,encryptedPayloads:payloads,context:{schemaVersion:1,company,viewer:manifest.viewer,viewerGroupIds:[],projects:[project],
          tasks:[{id:taskId,projectId,projectSlug,number:1,revisionToken:'b'.repeat(64),payload:{company,project,task:{id:taskId,title:marker(taskId,'title'),
            descriptionPlainText:marker(taskId,'description'),status:{code:'active',name:'Active'},participants:[],controls:[]}}}],
          instructions,workspaces:[],workspaceEntries:[],contextDocuments:[]}});return;
      }
      if(selected.pathname.endsWith('/reads/get_task_activity')){
        counts.current++;json(response,{schemaVersion:1,encryptedPayloads:payloads,context:{comments:[{id:randomUUID(),bodyText:marker(taskId,'current')}],pagination:{hasMore:false}}});return;
      }
      throw Error(`Unexpected synthetic backend route: ${request.method} ${selected.pathname}`);
    }catch(error){failures.push(error);json(response,{code:'SYNTHETIC_SCENARIO_REJECTED'},500);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,company,projectSlug,taskId,counts,manifest,descriptor,
    async setManagedDevice(device){
      managed=device;const aad={suite:'trelio-e2ee-v1',companyId:company.id,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId:cryptoDeviceId};
      const sealed=await hpkeSeal({recipientPublicEncryptionJwk:device.publicEncryptionJwk,
        plaintext:Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk:privateJwk})),aad});
      envelope={id:randomUUID(),...aad,hpkeEnc:sealed.enc,ciphertext:sealed.ciphertext,aad};
      if(fileCount){
        // Comparable *bytes and object count*, not copied production content.
        // 3,000 accepted 48-KiB sources produce ~150 MiB of real TRELIOE1
        // containers and thousands of independent protected resume-cache files.
        // Build with the SAME file codec/signature, never fake cleartext bytes.
        const directory=path.join(root,'synthetic-ciphertext');await fs.mkdir(directory);
        const sourcePath=path.join(directory,'source'),destinationPath=path.join(directory,'cipher');
        const seal=async(id,kind,bytes)=>{
          await fs.writeFile(sourcePath,bytes,{mode:0o600});
          await encryptFileToCompanyContainer({sourcePath,destinationPath,scopePublicEncryptionJwk:publicJwk,
            aad:{companyId:company.id,scopeId,scopeEpoch:1,entityType:`agent_workspace_browser_${kind}`,entityId:id,entityRevision:1,schemaVersion:1},
            originalName:kind==='manifest'?'manifest.json':'synthetic.txt',mimeType:kind==='manifest'?'application/json':'text/plain',
            writerDeviceId:cryptoDeviceId,signingPrivateKey:device.privateKeys.signingPrivateKey});
          const encrypted=await fs.readFile(destinationPath);containers.set(id,encrypted);counts.ciphertextBytes+=encrypted.length;
          await fs.unlink(destinationPath);
        };
        const files=[];
        for(let index=0;index<fileCount;index++){
          const id=randomUUID(),bytes=Buffer.from(`COLD_VOLUME_CANARY_${index}\n`+'synthetic filler text '.repeat(2500));
          const value=bytes.subarray(0,48*1024);await seal(id,'file',value);
          fileIds.push(id);files.push({id,path:`notes/${String(index).padStart(4,'0')}.txt`,contentType:'text/plain',sizeBytes:value.length});
        }
        await seal(manifestFileId,'manifest',Buffer.from(JSON.stringify({schemaVersion:1,kind:'agent-workspace-browser-manifest',
          projectionId,workspaceId,workspaceHead,files})));
        manifest.acceptedWorkspaces.push({id:workspaceId,acceptedHead:workspaceHead,taskId,projectId,projectSlug,taskNumber:1,title:'Synthetic accepted notes'});
        await fs.rm(directory,{recursive:true});
      }
    },
    fileHits(index){return hits.get(index)??0;},
    setMode(value){mode=value;},setClosed(value){closed=value;},assertClean(){if(failures.length)throw failures[0];},
    async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},
  };
};
