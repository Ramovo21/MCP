import { randomUUID } from 'node:crypto';
import { audit,type Database,type Sql } from '../../../packages/database/src/index.js';
import { AppError,publicError,type Principal,type ToolRecord,type Connection,type JsonObject } from '../../../packages/shared/src/index.js';
import { canonical,hash,redact,type SecretVault } from '../../../packages/shared/src/secrets.js';
import { canUse,evaluate,defaultPolicy,type Policy } from '../../../packages/policy-engine/src/index.js';
import { validateInput } from '../../../packages/mcp-core/src/validation.js';
import type { ConnectorWorker } from '../../../services/connector-worker/src/index.js';
import type { Authenticator } from './auth.js';
export interface Execution {id:string;organization_id:string;tool_id:string|null;tool_name:string;principal:Principal;arguments_encrypted:string|null;request_hash:string;status:string;result_metadata:JsonObject|null;error_metadata:JsonObject|null;started_at:string}
export class ExecutionService {
 constructor(readonly db:Database,readonly vault:SecretVault,private worker:ConnectorWorker,readonly auth:Authenticator){}
 async resolve(sql:Sql,p:Principal,name:string){const r=await sql.query<ToolRecord & {connection_status:string;permission:boolean|undefined}>(`select t.*,c.status connection_status,p.allowed permission from tools t join connections c on c.organization_id=t.organization_id and c.id=t.connection_id left join tool_permissions p on p.organization_id=t.organization_id and p.tool_id=t.id and p.role=$3 where t.organization_id=$1 and t.name=$2`,[p.organizationId,name,p.role]);const t=r.rows[0];if(!t||t.connection_status!=='active'||!canUse(p,t,t.permission??undefined))throw new AppError('FORBIDDEN','Tool unavailable or permission denied',403);return t;}
 async list(p:Principal){return this.db.tenant(p.organizationId,async sql=>{const r=await sql.query<ToolRecord & {permission:boolean|undefined}>(`select t.*,p.allowed permission from tools t join connections c on c.organization_id=t.organization_id and c.id=t.connection_id left join tool_permissions p on p.organization_id=t.organization_id and p.tool_id=t.id and p.role=$2 where t.organization_id=$1 and c.status='active' order by t.name`,[p.organizationId,p.role]);return r.rows.filter(t=>canUse(p,t,t.permission??undefined));});}
 async policy(sql:Sql,org:string){return (await sql.query<Policy>('select * from approval_policies where organization_id=$1',[org])).rows[0]??defaultPolicy;}
 async step(sql:Sql,org:string,id:string,stage:string,metadata:unknown={}){await sql.query('insert into execution_steps(organization_id,execution_id,stage,metadata) values($1,$2,$3,$4)',[org,id,stage,JSON.stringify(metadata)]);}
 async call(p:Principal,name:string,args:JsonObject,key?:string){
 const id=randomUUID(),idempotencyKey=key??randomUUID(),fingerprint=hash(canonical({name,args,user:p.userId,key:p.apiKeyId}));
 if(idempotencyKey.length>160)throw new AppError('INVALID_IDEMPOTENCY_KEY','Idempotency key too long');
 const initial=await this.db.tenant(p.organizationId,async sql=>{
 const existing=(await sql.query<Execution>('select * from executions where organization_id=$1 and idempotency_key=$2',[p.organizationId,idempotencyKey])).rows[0];
 if(existing){if(existing.request_hash!==fingerprint)throw new AppError('IDEMPOTENCY_CONFLICT','Idempotency key already used with another request',409);return {execution:existing,dispatch:false};}
 let tool:ToolRecord|undefined,decision={approval:false,reason:''},failure:unknown;
 try{tool=await this.resolve(sql,p,name);validateInput(tool.input_schema,args);decision=evaluate(tool,await this.policy(sql,p.organizationId));}catch(e){failure=e;}
 const status=failure?'denied':decision.approval?'pending':'running';
 const encrypted=failure?null:this.vault.seal(args,`${p.organizationId}:execution:${id}`);
 const r=await sql.query<Execution>(`insert into executions(id,organization_id,request_id,user_id,api_key_id,tool_id,tool_name,principal,arguments_redacted,arguments_encrypted,request_hash,idempotency_key,status,error_metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict(organization_id,idempotency_key) do nothing returning *`,[id,p.organizationId,randomUUID(),p.userId??null,p.apiKeyId??null,tool?.id??null,name,JSON.stringify(p),JSON.stringify(failure?{redacted:true}:redact(args,tool?.input_schema)),encrypted,fingerprint,idempotencyKey,status,failure?JSON.stringify(publicError(failure)):null]);
 if(!r.rows[0]){const other=(await sql.query<Execution>('select * from executions where organization_id=$1 and idempotency_key=$2',[p.organizationId,idempotencyKey])).rows[0]!;if(other.request_hash!==fingerprint)throw new AppError('IDEMPOTENCY_CONFLICT','Idempotency conflict',409);return {execution:other,dispatch:false};}
 await this.step(sql,p.organizationId,id,'authenticated');await this.step(sql,p.organizationId,id,failure?'denied':'policy_evaluated',{reason:decision.reason});
 if(decision.approval&&tool)await sql.query('insert into approval_requests(organization_id,execution_id,risk,reason,requested_by) values($1,$2,$3,$4,$5)',[p.organizationId,id,tool.risk,decision.reason,p.userId??null]);
 await audit(sql,p,'tool.requested',id,{tool:name,status});return {execution:r.rows[0],dispatch:status==='running'};
 });
 if(initial.dispatch)return this.dispatch(initial.execution,p);
 return this.response(initial.execution);
 }
 response(e:Execution){return {executionId:e.id,status:e.status,...(e.result_metadata?{result:e.result_metadata}:{}),...(e.error_metadata?{error:e.error_metadata}:{})};}
 async dispatch(e:Execution,p:Principal){const started=Date.now();try{
 const current=await this.auth.refresh(p);
 const data=await this.db.tenant(p.organizationId,async sql=>{const tool=await this.resolve(sql,current,e.tool_name);const connection=(await sql.query<Connection>('select * from connections where organization_id=$1 and id=$2',[p.organizationId,tool.connection_id])).rows[0]!;const secret=(await sql.query<{ciphertext:string}>('select ciphertext from connection_secrets where organization_id=$1 and connection_id=$2',[p.organizationId,tool.connection_id])).rows[0];await this.step(sql,p.organizationId,e.id,'dispatch_started');await sql.query('update executions set connector_id=$3 where organization_id=$1 and id=$2',[p.organizationId,e.id,connection.connector_id]);return {tool,connection,secrets:secret?this.vault.open<Record<string,string>>(secret.ciphertext,`${p.organizationId}:connection:${connection.id}`):{}};});
 const args=this.vault.open<JsonObject>(e.arguments_encrypted!,`${p.organizationId}:execution:${e.id}`);validateInput(data.tool.input_schema,args);
 const result=await this.worker.dispatch(data.tool,args,{...data,organizationId:p.organizationId,database:this.db,executionId:e.id,signal:AbortSignal.timeout(30000)});
 // Persist metadata only: results can contain provider secrets or personal data.
 const metadata={bytes:Buffer.byteLength(JSON.stringify(result)??'null'),type:Array.isArray(result)?'array':typeof result};
 await this.finish(e,p,'succeeded',metadata,null,Date.now()-started);
 return {executionId:e.id,status:'succeeded',result,durationMs:Date.now()-started};
 }catch(error){const safe=publicError(error);await this.finish(e,p,'failed',null,safe,Date.now()-started);return {executionId:e.id,status:'failed',error:safe,durationMs:Date.now()-started};}}
 async finish(e:Execution,p:Principal,status:string,result:unknown,error:unknown,duration:number){await this.db.tenant(p.organizationId,async sql=>{await sql.query('update executions set status=$3,result_metadata=$4,error_metadata=$5,finished_at=now(),duration_ms=$6,arguments_encrypted=null where organization_id=$1 and id=$2 and status=\'running\'',[p.organizationId,e.id,status,JSON.stringify(result),JSON.stringify(error),duration]);await this.step(sql,p.organizationId,e.id,status);await audit(sql,p,`tool.${status}`,e.id);});}
}
