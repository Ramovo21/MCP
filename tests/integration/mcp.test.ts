import { test,expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname,resolve } from 'node:path';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture } from '../helpers/fixture.js';
import { createApp } from '../../apps/gateway/src/app.js';
import { PostgresRateLimiter } from '../../apps/gateway/src/rate-limit.js';
const require=createRequire(import.meta.url);
test('official SDK and Inspector discover and call the real Streamable HTTP gateway',async()=>{
 const f=await fixture();const server=createApp({execution:f.execution,auth:f.auth,rateLimiter:new PostgresRateLimiter(f.db),webOrigin:'http://localhost:3000',hosts:['127.0.0.1']}).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No address');const url=`http://127.0.0.1:${address.port}/mcp`;
 const client=new Client({name:'omnimcp-test',version:'1'},{capabilities:{},versionNegotiation:{mode:{pin:'2026-07-28'}}});
 try{await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${f.key}`}}}));const listed=await client.listTools();expect(listed.tools.map(t=>t.name)).toContain('demo.crm.customer.search');
 const result=await client.callTool({name:'demo.crm.customer.search',arguments:{}});expect(JSON.stringify(result)).toContain('Ada Nguyen');
 const cli=resolve(dirname(require.resolve('@modelcontextprotocol/inspector/package.json')),'clients/launcher/build/index.js');
 async function inspect(args:string[]){return new Promise<string>((resolveResult,reject)=>{const child=spawn(process.execPath,[cli,'--cli',url,'--protocol-era','modern','--format','json','--header',`Authorization: Bearer ${f.key}`,...args],{windowsHide:true,env:{...process.env,MCP_CATALOG_PATH:resolve('.local/inspector-catalog.json')},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=String(b));child.stderr.on('data',b=>err+=String(b));child.on('error',reject);child.on('close',code=>code===0?resolveResult(out):reject(new Error(`Inspector ${code}: ${err} ${out}`)));});}
 expect(await inspect(['--method','tools/list'])).toContain('demo.crm.customer.search');
 expect(await inspect(['--method','tools/call','--tool-name','demo.crm.customer.search','--tool-args-json','{}'])).toContain('Ada Nguyen');
 expect(await inspect(['--method','tools/call','--tool-name','demo.crm.note.create','--tool-args-json',JSON.stringify({customerId:f.customer,body:'Approval smoke'})])).toContain('pending');
 }finally{await client.close();server.close();await once(server,'close');await f.db.close();}
},60000);
