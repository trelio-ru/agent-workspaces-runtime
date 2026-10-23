import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import test from "node:test";
import http from "node:http";

import {
  buildGeneratedAgentSecretWrite,
  generateDeterministicPassword,
  handleGeneratedAgentSecretSave,
  normalizeGeneratedAgentSecretInput,
  collectAgentSecretThroughProtectedForm,
  handleAssistantCompanySecretCreation,
} from "../host-runtime/scripts/trelio-secret-generate.mjs";
import { createAgentEncryptionDevice, decryptCompanyPayload } from "../host-runtime/scripts/trelio-company-encryption.mjs";
import { handleTrelioLocalActionOperation } from "../host-runtime/scripts/trelio-local-context.mjs";

const companyId = randomUUID();
const companySlug = "synthetic-company";
const secretId = randomUUID();
const companyMemberId = randomUUID();
const runId = randomUUID();
const fields = [
  { key: "password", label: "Пароль", type: "password", required: true },
  { key: "recovery_password", label: "Резервный пароль", type: "password", required: false },
];
const createInput = () => ({
  runId,
  expectedCurrentVersion: 0,
  clientRequestId: "synthetic-generate",
  userExplicitlyRequestedGeneratedPersistentStorage: true,
  generatedFields: [{ key: "password", generator: "password", length: 32 }],
  newSecret: {
    scopeType: "company",
    scopeId: companyId,
    name: "OpenWrt",
    templateType: "custom",
    fields,
  },
});
const contextFor = (encrypted) => ({
  companyId,
  companySlug,
  companyMemberId,
  secretId,
  currentVersion: 0,
  storageMode: encrypted ? "company_e2ee" : "trelio",
  encryptionState: encrypted ? "encrypted" : "plain",
  generatedSecretStorageSupported: true,
  fields,
});
const encryptionFixture = async () => {
  const scope = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const device = await createAgentEncryptionDevice();
  return {
    runtime: {
      state: "encrypted",
      accessState: "ready",
      company: { id: companyId, slug: companySlug },
      scope: {
        id: randomUUID(),
        epoch: 1,
        publicEncryptionJwk: await webcrypto.subtle.exportKey("jwk", scope.publicKey),
      },
      device: { id: randomUUID() },
    },
    device,
    scopePrivateEncryptionKey: {
      privateKey: scope.privateKey,
      privateJwk: await webcrypto.subtle.exportKey("jwk", scope.privateKey),
    },
  };
};

test("generated-secret input is value-free, explicit and password-only", () => {
  const valid = normalizeGeneratedAgentSecretInput(createInput());
  assert.equal(valid.generatedFields[0].length, 32);
  for (const input of [
    { ...createInput(), userExplicitlyRequestedGeneratedPersistentStorage: false },
    { ...createInput(), secretId },
    { ...createInput(), value: "must-not-be-accepted" },
    { ...createInput(), generatedFields: [{ key: "password", generator: "token", length: 32 }] },
    { ...createInput(), generatedFields: [{ key: "password", generator: "password", length: 8 }] },
    { ...createInput(), newSecret: { ...createInput().newSecret, fields: [
      { key: "username", label: "Логин", type: "username", required: true },
    ] } },
  ]) {
    assert.throws(
      () => normalizeGeneratedAgentSecretInput(input),
      (error) => error.code === "AGENT_SECRET_GENERATE_INPUT_INVALID",
    );
  }
});

test("password derivation is deterministic, strong by construction and domain-sensitive", () => {
  const key = Buffer.from("synthetic-paired-device-key", "utf8");
  const first = generateDeterministicPassword({ key, seed: "request-one", length: 48 });
  const replay = generateDeterministicPassword({ key, seed: "request-one", length: 48 });
  const another = generateDeterministicPassword({ key, seed: "request-two", length: 48 });
  assert.equal(first, replay);
  assert.notEqual(first, another);
  assert.equal(first.length, 48);
  assert.match(first, /[a-z]/u);
  assert.match(first, /[A-Z]/u);
  assert.match(first, /[0-9]/u);
  assert.match(first, /[^A-Za-z0-9]/u);
});

test("generated writes are retry-stable while E2EE keeps password bytes opaque", async () => {
  const input = normalizeGeneratedAgentSecretInput(createInput());
  const encryption = await encryptionFixture();
  const build = () => buildGeneratedAgentSecretWrite({
    input,
    context: contextFor(true),
    token: "synthetic-paired-token",
    companyEncryption: encryption,
  });
  const first = await build();
  const replay = await build();
  assert.equal(first.localWrite.requestFingerprint, replay.localWrite.requestFingerprint);
  assert.notEqual(first.localWrite.encryptedPayloads[1].ciphertext, replay.localWrite.encryptedPayloads[1].ciphertext);
  assert.equal(first.userExplicitlyRequestedGeneratedPersistentStorage, true);
  assert.equal(first.userExplicitlyRequestedPersistentStorage, undefined);
  assert.equal(first.localWrite.values.$trelioE2ee.id, secretId);
  assert.equal(first.localWrite.values.$trelioE2ee.field, "values_json");

  const valuePayload = first.localWrite.encryptedPayloads.find(
    (payload) => payload.entityType === "agent_secret.value",
  );
  const opened = await decryptCompanyPayload({
    encryptedPayload: valuePayload,
    scopePrivateKey: encryption.scopePrivateEncryptionKey.privateKey,
    scopePrivateJwk: encryption.scopePrivateEncryptionKey.privateJwk,
  });
  const password = opened.values.values_json.password;
  assert.equal(password.length, 32);
  assert.match(password, /[a-z]/u);
  assert.match(password, /[A-Z]/u);
  assert.match(password, /[0-9]/u);
  assert.match(password, /[^A-Za-z0-9]/u);

  const changed = await buildGeneratedAgentSecretWrite({
    input: { ...input, clientRequestId: "another-request" },
    context: contextFor(true),
    token: "synthetic-paired-token",
    companyEncryption: encryption,
  });
  assert.notEqual(first.localWrite.requestFingerprint, changed.localWrite.requestFingerprint);
});

test("plain generation stays inside the local transport and never enters public input", async () => {
  const input = normalizeGeneratedAgentSecretInput(createInput());
  const write = await buildGeneratedAgentSecretWrite({
    input,
    context: contextFor(false),
    token: "synthetic-paired-token",
    companyEncryption: null,
  });
  assert.equal(write.localWrite.contentProtection, "server_keyring_v1");
  assert.equal(write.localWrite.values.password.length, 32);
  assert.equal(JSON.stringify(input).includes(write.localWrite.values.password), false);
});

test("local facade performs value-free preflight and returns only a safe receipt", async () => {
  const encryption = await encryptionFixture();
  const calls = [];
  const result = await handleGeneratedAgentSecretSave("https://trelio.example", {
    companySlug,
    arguments: createInput(),
    runtimeSessionProof: { synthetic: "one-use-hook-proof" },
  }, {
    getToken: async () => "synthetic-paired-token",
    checkCompatibility: async () => {},
    getEncryptionContext: async () => encryption,
    sendRequest: async (_origin, _token, pathname, options) => {
      calls.push({ pathname, ...options });
      if (calls.length === 1) {
        assert.match(pathname, /generated-save-context/u);
        assert.equal(options.body, undefined);
        return { json: async () => contextFor(true) };
      }
      const body = JSON.parse(options.body);
      assert.equal(body.nativeTool, "generate_agent_secret");
      assert.equal(body.arguments.localWrite.values.$trelioE2ee.id, secretId);
      assert.equal(body.arguments.localWrite.values.$trelioE2ee.field, "values_json");
      return { json: async () => ({
        structuredContent: {
          ok: true,
          secret: {
            id: secretId,
            currentVersion: 1,
            storageMode: "company_e2ee",
            hasValue: true,
          },
          unexpected: "server-data-must-not-pass-through",
        },
      }) };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(result.structuredContent).sort(), ["ok", "replayed", "secret", "setupUrl"]);
  assert.equal(JSON.stringify(result).includes("server-data-must-not-pass-through"), false);
});

test("generic local action intercepts generation before provider lookup", async () => {
  const rejected = await handleTrelioLocalActionOperation("https://trelio.example", {
    companySlug,
    nativeTool: "generate_agent_secret",
    arguments: {
      ...createInput(),
      userExplicitlyRequestedGeneratedPersistentStorage: false,
    },
  });
  assert.equal(rejected.structuredContent.code, "AGENT_SECRET_GENERATE_INPUT_INVALID");
});

// Actual loopback requests exercise the shared guard/renderer rather than a
// fake collector. Synthetic values never leave this disposable test process.
const protectedFormRequest = (url, body) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const incoming = http.request(target, { method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { origin: target.origin,
      "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1" } }),
  }, response => {
    let html = "";
    response.setEncoding("utf8");
    response.on("data", chunk => { html += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, html, headers: response.headers }));
  });
  incoming.on("error", reject);
  incoming.end(body);
});
const capturedFields = [{ key: "username", label: "Логин", type: "username", required: true },
  { key: "password", label: "Пароль", type: "password", required: true }];
const protectedFormOptions = { origin: "https://trelio.example", fields: capturedFields,
  holder: "company", browserPlatform: "darwin", handoffTimeoutMs: 200, setupTimeoutMs: 1500 };
const protectedFormBody = (url, values = {}) => new URLSearchParams({
  nonce: new URL(url).searchParams.get("nonce"), decision: "save",
  username: "synthetic-login", password: "  synthetic-secret  ", ...values,
}).toString();

test("protected company/private input saves once through the same local form without returning values", async () => {
  for (const holder of ["company", "assistant"]) {
    let writes = 0, captured;
    const result = await collectAgentSecretThroughProtectedForm({ ...protectedFormOptions, holder,
      persistValues: async values => {
        writes++;
        assert.deepEqual({ ...values }, { username: "synthetic-login", password: "  synthetic-secret  " });
        captured = values;
      },
      openBrowserFn: async url => {
        const form = await protectedFormRequest(url);
        assert.equal(form.status, 200);
        assert.match(form.headers["content-security-policy"], /form-action 'self'/u);
        assert.equal(form.headers["cache-control"], "no-store");
        assert.equal(form.html.includes("synthetic-secret"), false);
        assert.equal(form.html.includes('autocomplete="off"'), true);
        const saved = await protectedFormRequest(new URL("/credential", url), protectedFormBody(url));
        assert.equal(saved.status, 200);
        assert.match(saved.html, /Trelio подтвердил сохранение/u);
        assert.equal(saved.html.includes("synthetic-secret"), false);
      },
    });
    assert.equal(result, undefined);
    assert.equal(writes, 1);
    assert.equal(Object.keys(captured).length, 0);
  }
});

test("protected input keeps validation retry separate from an unknown write and closes the mutation latch", async () => {
  let writes = 0, candidate;
  await assert.rejects(collectAgentSecretThroughProtectedForm({ ...protectedFormOptions,
    persistValues: async values => { writes++; candidate = values; throw new Error("synthetic-secret-upstream-error"); },
    openBrowserFn: async url => {
      await protectedFormRequest(url);
      const endpoint = new URL("/credential", url);
      const invalid = await protectedFormRequest(endpoint, protectedFormBody(url, { password: "" }));
      assert.equal(invalid.status, 400);
      assert.match(invalid.html, /Проверьте обязательные поля/u);
      assert.equal(writes, 0);
      const unknown = await protectedFormRequest(endpoint, protectedFormBody(url));
      assert.equal(unknown.status, 409);
      assert.match(unknown.html, /Сохранение не подтверждено/u);
      assert.equal(unknown.html.includes("synthetic-secret"), false);
      assert.equal(unknown.html.includes("<form"), false);
      // The listener is closed at completion. Even a racing second request
      // may only encounter the existing one-flight latch or a closed socket.
      try { assert.equal((await protectedFormRequest(endpoint, protectedFormBody(url))).status, 409); }
      catch (error) { assert.ok(["ECONNREFUSED", "ECONNRESET"].includes(error.code)); }
    },
  }), error => error.code === "PROTECTED_FORM_SAVE_UNCONFIRMED" && !error.message.includes("synthetic-secret"));
  assert.equal(writes, 1);
  assert.equal(Object.keys(candidate).length, 0);
});

test("protected input cancel and unopened/expired forms never report a saved Secret", async () => {
  let writes = 0;
  await assert.rejects(collectAgentSecretThroughProtectedForm({ ...protectedFormOptions,
    persistValues: async () => { writes++; },
    openBrowserFn: async url => {
      await protectedFormRequest(url);
      const cancelled = await protectedFormRequest(new URL("/credential", url),
        new URLSearchParams({ nonce: new URL(url).searchParams.get("nonce"), decision: "cancel" }).toString());
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.html.includes("Сохранено"), false);
    },
  }), error => error.code === "PROTECTED_FORM_CANCELLED");
  await assert.rejects(collectAgentSecretThroughProtectedForm({ ...protectedFormOptions, setupTimeoutMs: 30,
    persistValues: async () => { writes++; }, openBrowserFn: async url => { await protectedFormRequest(url); },
  }), error => error.code === "REMOTE_MCP_CREDENTIAL_SETUP_TIMEOUT");
  assert.equal(writes, 0);
});

test("protected input rejects duplicate/unknown fields and the existing transport bound before native persistence", async () => {
  let writes = 0;
  await collectAgentSecretThroughProtectedForm({ ...protectedFormOptions,
    persistValues: async () => { writes++; },
    openBrowserFn: async url => {
      await protectedFormRequest(url);
      const endpoint = new URL("/credential", url);
      for (const body of [protectedFormBody(url) + "&password=duplicate",
        protectedFormBody(url) + "&secretId=not-native-authority",
        protectedFormBody(url, { password: "x".repeat(8192) })]) {
        const refused = await protectedFormRequest(endpoint, body);
        assert.equal(refused.status, 400);
        assert.equal(writes, 0);
        assert.equal(refused.html.includes("synthetic-secret"), false);
      }
      assert.equal((await protectedFormRequest(endpoint, protectedFormBody(url))).status, 200);
    },
  });
  assert.equal(writes, 1);
  for (const schema of [[{ ...capturedFields[0], key: "nonce" }], [capturedFields[0], capturedFields[0]]]) {
    await assert.rejects(collectAgentSecretThroughProtectedForm({ ...protectedFormOptions, fields: schema,
      persistValues: async () => { writes++; }, openBrowserFn: async () => { throw new Error("must-not-open"); },
    }), error => error.code === "AGENT_SECRET_PROTECTED_INPUT_INVALID");
  }
  assert.equal(writes, 1);
});


test("company NEW generation/empty/input share the Secret codec, exact receipts and no human flags",async()=>{
  for(const encrypted of [false,true])for(const valueSource of ["empty","generated","protected_input"]){
    const encryption=encrypted?await encryptionFixture():null;
    const scope={assistantUserId:randomUUID(),deviceId:randomUUID(),companyId,taskId:randomUUID()};
    const input={holder:"company",clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString(),ownerDecisionId:randomUUID(),runId,
      plan:{metadataMode:"neutral",cardType:"password",scopeType:"task",runId,valueSource,
        ...(valueSource==="generated"?{generatedFields:[{key:"password",generator:"password",length:24}]}:{})}};
    const schema=[{key:"password",label:"Password",type:"password",required:true}];
    const context={schemaVersion:1,completed:false,...scope,secretId,runId,companySlug,companyMemberId,scopeType:"task",scopeId:scope.taskId,
      storageMode:encrypted?"company_e2ee":"trelio",encryptionState:encrypted?"encrypted":"plain",currentVersion:0,generatedSecretStorageSupported:true,
      protectedInputStorageSupported:true,valueSource,metadata:{name:"Company secret",publicDescription:"",templateType:"custom",fields:schema},fields:schema,
      ...(valueSource==="generated"?{generatedFields:input.plan.generatedFields}:{})};
    const receipt={created:true,secret:{id:secretId,holder:"company",companyId,scopeType:"task",scopeId:scope.taskId,
      storageMode:context.storageMode,currentVersion:valueSource==="empty"?0:1,hasValue:valueSource!=="empty"},setupPath:`/${companySlug}/agent-secrets/${secretId}/setup/`};
    let pending=false,saved=false,forms=0,selected=0;const writes=[];
    const options={origin:"https://trelio.ru",input,scope,token:"OPAQUE_HANDLE_MUST_NOT_BE_KEY",companyEncryption:encryption,
      withGenerationKey:action=>action(Buffer.from("synthetic-device-credential")),onContext:async current=>{assert.equal(current.secretId,secretId);selected++;},
      collectValues:async({persistValues})=>{forms++;await persistValues({password:"synthetic-user-entered-password"});},
      sendRequest:async(_origin,_token,pathname,options={})=>{
        if(!options.method)return {json:async()=>saved?{completed:true,receipt}:pending?{pending:true,secretId}:context};
        const body=JSON.parse(options.body);writes.push(body);assert.equal(body.holder,"company");assert.equal(body.ownerDecisionId,input.ownerDecisionId);
        assert.equal(body.userExplicitlyRequestedGeneratedPersistentStorage,undefined);assert.equal(body.userExplicitlyRequestedPersistentStorage,undefined);
        if(body.stage==="begin"){pending=true;return {json:async()=>({started:true,secretId})};}
        saved=true;return {json:async()=>({completed:true,receipt})};
      }};
    assert.deepEqual(await handleAssistantCompanySecretCreation(options),receipt);assert.equal(selected,1);
    assert.equal(forms,valueSource==="protected_input"?1:0);assert.equal(writes.length,valueSource==="protected_input"?2:1);
    const write=writes.at(-1);assert.equal(write.newSecret,undefined);assert.equal(write.fields[0].key,"password");
    if(encrypted){
      assert.match(write.name,/^~e1:/u);assert.ok(!JSON.stringify(write).includes("synthetic-user-entered-password"));
      const metadata=write.encryptedPayloads.find(p=>p.entityType==="agent_secret.metadata");
      const opened=await decryptCompanyPayload({encryptedPayload:metadata,scopePrivateKey:encryption.scopePrivateEncryptionKey.privateKey,scopePrivateJwk:encryption.scopePrivateEncryptionKey.privateJwk});
      assert.equal(opened.values.name,"Company secret");assert.equal(write.encryptedPayloads.length,valueSource==="empty"?1:2);
    }else assert.equal(write.name,"Company secret");
    const before=writes.length;
    assert.deepEqual(await handleAssistantCompanySecretCreation({...options,withGenerationKey:()=>assert.fail("receipt before key")}),receipt);
    assert.equal(writes.length,before);assert.equal(forms,valueSource==="protected_input"?1:0);
  }
});

test("company protected input never reopens on pending or retries an unknown save and immediately reads its receipt",async()=>{
  const scope={assistantUserId:randomUUID(),deviceId:randomUUID(),companyId,taskId:randomUUID()};
  const input={holder:"company",clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString(),ownerDecisionId:randomUUID(),runId,
    plan:{metadataMode:"neutral",cardType:"password",scopeType:"task",runId,valueSource:"protected_input"}};
  let writes=0;
  await assert.rejects(handleAssistantCompanySecretCreation({origin:"https://trelio.ru",input,scope,token:"opaque",withGenerationKey:()=>assert.fail(),
    sendRequest:async()=>({json:async()=>({pending:true,secretId})})}),e=>e.code==="ASSISTANT_SECRET_INPUT_ATTEMPT_UNCERTAIN");
  const schema=[{key:"password",label:"Password",type:"password",required:true}];
  const context={schemaVersion:1,completed:false,...scope,secretId,runId,companySlug,companyMemberId,scopeType:"task",scopeId:scope.taskId,
    storageMode:"trelio",encryptionState:"plain",currentVersion:0,generatedSecretStorageSupported:true,protectedInputStorageSupported:true,
    valueSource:"protected_input",metadata:{name:"Company secret",publicDescription:"",templateType:"custom",fields:schema},fields:schema};
  const receipt={created:true,secret:{id:secretId,holder:"company",companyId,scopeType:"task",scopeId:scope.taskId,storageMode:"trelio",currentVersion:1,hasValue:true}};
  let pending=false,saved=false,reads=0,forms=0;
  const result=await handleAssistantCompanySecretCreation({origin:"https://trelio.ru",input,scope,token:"opaque",
    withGenerationKey:action=>action(Buffer.from("synthetic-device-key")),collectValues:async({persistValues})=>{forms++;await persistValues({password:"original-value"});},
    sendRequest:async(_origin,_token,_path,options={})=>{
      if(!options.method){reads++;return {json:async()=>saved?{completed:true,receipt}:pending?{pending:true,secretId}:context};}
      writes++;const body=JSON.parse(options.body);if(body.stage==="begin"){pending=true;return {json:async()=>({started:true,secretId})};}
      saved=true;throw new Error("synthetic unknown response after commit");
    }});
  assert.equal(result.secret.id,secretId);assert.equal(writes,2);assert.equal(forms,1);assert.equal(reads,3);
});

test('private input shares company capture execution while task encryption never changes its global keyring holder',async()=>{
  const {handleAssistantNewSecretCreation}=await import('../host-runtime/scripts/trelio-secret-generate.mjs');
  const encryption=await encryptionFixture();
  const scope={assistantUserId:randomUUID(),deviceId:randomUUID(),companyId,taskId:randomUUID()};
  const input={holder:'assistant',clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString(),ownerDecisionId:randomUUID(),runId,
    plan:{metadataMode:'neutral',cardType:'login',runId,valueSource:'protected_input'}};
  const context={schemaVersion:1,completed:false,...scope,secretId:input.clientRequestId,runId,storageMode:'trelio',currentVersion:0,
    valueSource:'protected_input',protectedInputStorageSupported:true,metadata:{name:'Personal secret',templateType:'login'},fields:capturedFields};
  const receipt={created:true,secret:{id:input.clientRequestId,holder:'assistant',scopeType:'assistant',storageMode:'trelio',currentVersion:1,hasValue:true}};
  let pending=false,saved=false,forms=0,reads=0;const writes=[];
  const options={origin:'https://trelio.ru',input,scope,token:{opaque:true},companyEncryption:encryption,
    withGenerationKey:action=>action(Buffer.from('synthetic-native-device-key')),
    collectValues:async({holder,persistValues})=>{assert.equal(holder,'assistant');forms++;await persistValues({username:'synthetic-user',password:'PRIVATE_CAPTURE_RUNTIME_CANARY'});},
    sendRequest:async(_origin,_token,_path,options={})=>{
      if(!options.method){reads++;return {json:async()=>saved?{completed:true,receipt}:pending?{pending:true,secretId:input.clientRequestId}:context};}
      const body=JSON.parse(options.body);writes.push(body);
      if(body.stage==='begin'){pending=true;return {json:async()=>({started:true,secretId:input.clientRequestId})};}
      assert.deepEqual(Object.keys(body).sort(),['clientRequestId','expectedCurrentVersion','expectedTaskUpdatedAt','holder','ownerDecisionId','plan','requestFingerprint','runId','secretId','stage','values']);
      assert.equal(body.values.password,'PRIVATE_CAPTURE_RUNTIME_CANARY');
      saved=true;throw new Error('synthetic private save reply lost');
    }};
  const result=await handleAssistantNewSecretCreation(options);
  assert.deepEqual(result,receipt);assert.equal(forms,1);assert.equal(writes.length,2);assert.equal(reads,3);
  assert.equal(JSON.stringify(result).includes('PRIVATE_CAPTURE_RUNTIME_CANARY'),false);
  assert.deepEqual(await handleAssistantNewSecretCreation({...options,withGenerationKey:()=>assert.fail('committed receipt precedes key/input')}),receipt);
  assert.equal(forms,1);assert.equal(writes.length,2);
  await assert.rejects(handleAssistantNewSecretCreation({...options,sendRequest:async()=>({json:async()=>({pending:true,secretId:input.clientRequestId})}),
    withGenerationKey:()=>assert.fail('pending capture cannot open another form')}),e=>e.code==='ASSISTANT_SECRET_INPUT_ATTEMPT_UNCERTAIN');
});
