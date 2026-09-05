import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const MARKER='<!-- pulsechain-grok-operations-event@1.0.0 -->';
const RECEIPT_MARKER='<!-- pulsechain-grok-operations-receipt@1.0.0 -->';
const REPO='opus99999/pulsechain-mcp';
const BASE='https://pulsechain-research-control-room.brohexphiat.chatgpt.site';
const AUD=BASE+'/api/v1/grok-operations/events/github';
const WORKFLOW=REPO+'/.github/workflows/grok-operations-ingest.yml@refs/heads/main';
const PAIRS={'chatgpt-worker-1':'signals-platform','chatgpt-worker-2':'validator-flows','chatgpt-worker-3':'identity-attribution','chatgpt-worker-4':'investor-intelligence'};
function requireThat(ok,code){if(!ok)throw Error(code);}
function canonical(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
export function parseComment(body){
 requireThat(typeof body==='string'&&Buffer.byteLength(body)<=24000,'COMMENT_SIZE_INVALID');
 const m=/^<!-- pulsechain-grok-operations-event@1\.0\.0 -->\r?\n```json\r?\n([\s\S]+)\r?\n```\s*$/.exec(body);requireThat(m,'EXACT_EVENT_COMMENT_REQUIRED');
 const parsed=JSON.parse(m[1]);requireThat(Object.keys(parsed).sort().join('|')==='event|worker_id|workstream_id','COMMENT_FIELDS_INVALID');
 const e=parsed.event;requireThat(e&&e.schema_version==='pulsechain-grok-operations-event@1.0.0'&&e.public_safe===true,'EVENT_SCHEMA_REQUIRED');
 requireThat(e.provider_agent_id===null&&e.website_identity_when_applicable===null,'PROVIDER_IMPERSONATION_REJECTED');
 if(e.record_type==='GROK_OPERATIONS_REQUEST')requireThat(parsed.worker_id==='chatgpt-head-chef'&&parsed.workstream_id==='head-chef-coordination'&&e.acting_role==='CHATGPT_HEAD_CHEF_COORDINATION','HEAD_CHEF_REQUIRED');
 else requireThat(e.record_type==='GROK_SPECIALIST_FEEDBACK'&&PAIRS[parsed.worker_id]===parsed.workstream_id&&parsed.worker_id===e.target_worker_id&&parsed.workstream_id===e.target_workstream_id&&e.acting_role==='CHATGPT_SPECIALIST_REVIEW','EXACT_SPECIALIST_REQUIRED');
 const {content_sha256,...unsigned}=e;requireThat(content_sha256==='sha256:'+createHash('sha256').update(canonical(unsigned)).digest('hex'),'CONTENT_HASH_MISMATCH');
 return parsed;
}
export function verifyReceipt(r,event){requireThat(r?.schema_version==='pulsechain-grok-operations-receipt@1.0.0'&&r.accepted===true&&r.event_id===event.event_id&&r.source_request_id===event.source_request_id&&r.record_type===event.record_type&&r.content_sha256===event.content_sha256&&Number.isSafeInteger(r.d1_sequence)&&r.d1_sequence>0&&r.receipt_id==='grok-operations-receipt:'+event.event_id&&r.specialist_pointer_delta===0&&r.governed_lifecycle_events_created===0&&r.financial_execution_state_delta===0&&r.accepted_specialist_evidence===false,'EXACT_RECEIPT_REQUIRED');return r;}
export async function run(env=process.env,fetcher=fetch){
 const context=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
 requireThat(context.action==='created'&&env.GITHUB_EVENT_NAME==='issue_comment'&&context.repository?.full_name===REPO&&context.repository?.id===1320639709&&context.repository?.owner?.id===212180323&&context.issue?.number===43&&!context.issue?.pull_request&&context.comment?.user?.login==='opus99999'&&context.comment?.user?.id===212180323&&env.GITHUB_ACTOR==='opus99999'&&env.GITHUB_TRIGGERING_ACTOR==='opus99999','IMMUTABLE_SOURCE_REQUIRED');
 requireThat(env.GITHUB_WORKFLOW_REF===WORKFLOW&&env.GITHUB_WORKFLOW_SHA===env.GITHUB_SHA&&/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')&&/^[1-9][0-9]+$/.test(env.GITHUB_RUN_ID||'')&&/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT||''),'WORKFLOW_IDENTITY_REQUIRED');
 const github=async(path,init={})=>{const response=await fetcher('https://api.github.com/repos/'+REPO+path,{...init,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+env.GITHUB_TOKEN,'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'}});requireThat(response.ok,'GITHUB_HTTP_'+response.status);return response.json();};
 const original=context.comment,live=await github('/issues/comments/'+original.id);
 requireThat(live.body===original.body&&live.updated_at===original.updated_at&&live.created_at===live.updated_at&&live.user?.id===212180323&&live.issue_url==='https://api.github.com/repos/'+REPO+'/issues/43','SOURCE_EDITED_OR_MOVED');
 const {event,worker_id,workstream_id}=parseComment(original.body);
 const receipts=[];let complete=false;
 for(let page=1;page<=50;page++){const comments=await github('/issues/43/comments?per_page=100&page='+page);requireThat(Array.isArray(comments),'COMMENTS_INVALID');for(const c of comments){if(c.body?.startsWith(RECEIPT_MARKER)){const m=/```json\n([\s\S]+)\n```/.exec(c.body);if(m){const r=JSON.parse(m[1]);if(r.event_id===event.event_id)receipts.push({comment:c,receipt:r});}}}if(comments.length<100){complete=true;break;}}
 requireThat(complete,'COMMENT_COVERAGE_INCOMPLETE');requireThat(receipts.length<=1,'DUPLICATE_RECEIPT_CONFLICT');
 const readback=async()=>{const response=await fetcher(BASE+'/api/v1/grok-operations/requests/'+encodeURIComponent(event.source_request_id),{redirect:'error',signal:AbortSignal.timeout(20000)});requireThat(response.ok,'D1_READBACK_HTTP_'+response.status);const p=await response.json();const r=p.records?.find(x=>x.event?.event_id===event.event_id);requireThat(r&&canonical(r.event)===canonical(event),'EXACT_D1_READBACK_REQUIRED');return verifyReceipt(r.receipt,event);};
 if(receipts.length){requireThat(receipts[0].comment.user?.login==='github-actions[bot]'&&receipts[0].comment.user?.type==='Bot','RECEIPT_PUBLISHER_REJECTED');verifyReceipt(receipts[0].receipt,event);await readback();console.log(JSON.stringify({event_id:event.event_id,already_receipted:true,receipt_comment_id:receipts[0].comment.id}));return;}
 const oidcUrl=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);requireThat(oidcUrl.protocol==='https:','OIDC_URL_INVALID');oidcUrl.searchParams.set('audience',AUD);
 const tokenResponse=await fetcher(oidcUrl,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}});requireThat(tokenResponse.ok,'OIDC_REQUEST_FAILED');const {value:token}=await tokenResponse.json();requireThat(typeof token==='string','OIDC_TOKEN_UNAVAILABLE');
 const source={repository:REPO,issue_number:43,comment_id:original.id,comment_author:'opus99999',worker_id,workstream_id,workflow_ref:env.GITHUB_WORKFLOW_REF,workflow_sha:env.GITHUB_WORKFLOW_SHA,run_id:Number(env.GITHUB_RUN_ID),run_attempt:Number(env.GITHUB_RUN_ATTEMPT)};
 // One append attempt. A lost response is ambiguous and is never retried here.
 const response=await fetcher(AUD,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({event,source})});
 requireThat(response.ok,'APPEND_HTTP_'+response.status+'_RECONCILE_EXACT_EVENT_BEFORE_RETRY');const accepted=verifyReceipt(await response.json(),event);const stored=await readback();requireThat(stored.d1_sequence===accepted.d1_sequence,'RECEIPT_SEQUENCE_CONFLICT');
 const receiptComment=await github('/issues/43/comments',{method:'POST',body:JSON.stringify({body:RECEIPT_MARKER+'\n```json\n'+JSON.stringify(accepted,null,2)+'\n```'})});
 const checked=await github('/issues/comments/'+receiptComment.id);requireThat(checked.body===receiptComment.body,'RECEIPT_COMMENT_READBACK_REQUIRED');
 console.log(JSON.stringify({event_id:event.event_id,d1_sequence:accepted.d1_sequence,receipt_comment_id:receiptComment.id,accepted:true}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){run().catch(e=>{console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'TRANSPORT_FAILED_RECONCILE_EXACT_EVENT_BEFORE_RETRY');process.exitCode=1;});}
