import assert from 'node:assert/strict';
import test from 'node:test';
import { handleNativeLocalContextRead, searchCompanyContextMirror } from '../host-runtime/scripts/trelio-local-context.mjs';

const company={id:'11111111-1111-4111-8111-111111111111',slug:'acme',name:'Acme'};
const project={id:'22222222-2222-4222-8222-222222222222',slug:'core',name:'Core'};
const base={company,viewer:{memberId:'33333333-3333-4333-8333-333333333333',companyRole:'owner'},generation:'a'.repeat(64),serverGeneration:'b'.repeat(64),projects:[project],contextDocuments:[],searchDocuments:[],workspaces:[],workspaceEntries:[],tasks:[],instructions:{company:null,projects:[],userProfile:null}};
const document=(type,id,payload,scope=null)=>({type,id,title:payload[type]?.title||id,revisionToken:'a'.repeat(64),projectId:scope?.id??null,projectSlug:scope?.slug??null,payload});
const meeting=(id,state)=>({id:`context:meeting:${id}`,cacheKey:id,type:'meeting',title:'needle',stableKey:id,fields:[{source:'meeting-title',values:['needle']}],metadata:{contextDocumentId:id,meetingState:state,occurredAt:'2026-10-30T10:00:00.000Z'}});

test('meeting archive filtering uses canonical state and never loses includeArchived results',()=>{
  const mirror={...base,searchDocuments:[meeting('active','draft'),meeting('archived','archived')]};
  assert.deepEqual(handleNativeLocalContextRead(mirror,'search_meetings',{query:'needle',includeArchived:false}).items.map(x=>x.id),['active']);
  assert.deepEqual(handleNativeLocalContextRead(mirror,'search_meetings',{query:'needle',includeArchived:true}).items.map(x=>x.id),['active','archived']);
  assert.deepEqual(searchCompanyContextMirror(mirror,['needle'],5).results.map(x=>x.contextDocumentId),['active']);
});

test('meeting date filters compare instants, offsets and equal milliseconds',()=>{
  const mirror={...base,searchDocuments:[meeting('active','draft')]};
  for(const [filters,expected] of [
    [{occurredFrom:'2026-10-30T11:00:00+03:00'},1],
    [{occurredTo:'2026-10-30T11:00:00+03:00'},0],
    [{occurredFrom:'2026-10-30T10:00:00Z'},1],
    [{occurredTo:'2026-10-30T10:00:00+00:00'},1],
  ])assert.equal(handleNativeLocalContextRead(mirror,'search_meetings',{query:'needle',...filters}).total,expected);
  for(const filters of [{occurredFrom:'invalid'},{occurredFrom:'2026-10-31T00:00:00Z',occurredTo:'2026-10-30T00:00:00Z'}])
    assert.throws(()=>handleNativeLocalContextRead(mirror,'search_meetings',{query:'needle',...filters}),{code:'LOCAL_CONTEXT_INVALID_INPUT'});
});

test('list queries exclude relations/history and retain native task workflow and people',()=>{
  const contact=document('contact','contact',{contact:{id:'contact',displayName:'Person',channels:[{value:'channel-only'}]},history:[{text:'history-only'}]});
  for(const query of ['channel-only','history-only'])assert.equal(handleNativeLocalContextRead({...base,contextDocuments:[contact]},'list_contacts',{query}).total,0);
  const task={id:'task',number:17,projectId:project.id,projectSlug:project.slug,payload:{project,task:{title:'Task',descriptionPlainText:'alpha separate beta',status:{name:'Review',code:'review',kind:'review'},createdBy:{name:'Alice',memberId:base.viewer.memberId},checklists:[{title:'unlisted'}],dueAt:new Date().toISOString().slice(0,10)+'T00:00:00Z'}}};
  const mirror={...base,tasks:[task]};
  for(const [query,count] of [['review',1],['alice',1],['unlisted',0],['alpha beta',0]])
    assert.equal(handleNativeLocalContextRead(mirror,'list_project_tasks',{projectSlug:'core',query}).tasks.length,count,query);
  assert.equal(handleNativeLocalContextRead(mirror,'list_project_tasks',{projectSlug:'core',dueState:'upcoming'}).tasks.length,1);
});

test('registry rows search document labels only; NULL sort matches PostgreSQL before pagination',()=>{
  const registry=document('registry','registry',{registry:{id:'registry',slug:'registry',title:'Registry',columns:[{key:'n',type:'number'},{key:'doc',type:'document'}]},rows:[
    {rowKey:'missing',values:{}},{rowKey:'negative',values:{n:-1}},{rowKey:'zero',values:{n:0}},
    {rowKey:'published',values:{n:1,doc:[{label:'Report',fileName:'report.pdf',workspaceId:'private-id',workspacePath:'internal-path/report.pdf'}]}}
  ]});
  const mirror={...base,contextDocuments:[registry]};
  const read=input=>handleNativeLocalContextRead(mirror,'get_registry',{registrySlug:'registry',...input}).document.payload;
  for(const query of ['private-id','internal-path'])assert.equal(read({query}).rows.length,0);
  assert.equal(read({query:'Report'}).rows.length,1);
  assert.deepEqual(read({sortKey:'n',sortDirection:'asc'}).rows.map(x=>x.rowKey),['negative','zero','published','missing']);
  assert.deepEqual(read({sortKey:'n',sortDirection:'desc',offset:0,limit:1}).rows.map(x=>x.rowKey),['missing']);
});

test('registry company scope stays distinct from a same-slug project registry',()=>{
  const make=(id,scope)=>document('registry',id,{registry:{id,slug:'same',title:'Registry',columns:[]},rows:[]},scope);
  const mirror={...base,contextDocuments:[make('project',project),make('company',null)]};
  assert.deepEqual(handleNativeLocalContextRead(mirror,'list_registries',{}).items.map(x=>x.id),['company']);
  assert.equal(handleNativeLocalContextRead(mirror,'get_registry',{registrySlug:'same'}).document.id,'company');
});

test('decorated previews cannot lower lexical quality; equal evidence uses exact discussion locator', () => {
  const set = {
    id: 'context:regular_work:set', cacheKey: 'set', type: 'regular_work', title: 'Routine',
    stableKey: 'acme/core/set/regular-work', referenceValues: [],
    fields: [
      { source: 'regular-work-comment', values: ['needle'], previewValues: ['Context', 'needle'], publicPath: '/set/?comment=z' },
      { source: 'regular-work-comment', values: ['needle'], previewValues: ['Context', 'needle'], publicPath: '/set/?comment=a' },
    ], metadata: { contextDocumentId: 'set' },
  };
  const result = searchCompanyContextMirror({ ...base, searchDocuments: [set] }, ['needle'], 5, { includeMatchDetails: true });
  assert.equal(result.results[0].matches[0].lexicalQuality, 300);
  assert.equal(result.results[0].url, '/set/?comment=a');
  assert.deepEqual(result.results[0].matchedQueries, ['needle']);
  assert.deepEqual(result.pagination, { limit: 5, total: 1, returned: 1, hasMore: false });
});
