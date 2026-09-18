import { createMcpHandler,Server } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Request,Response } from 'express';
import type { ExecutionService } from '../../../apps/gateway/src/execution.js';
import { publicError,type Principal } from '../../shared/src/index.js';
export async function handleMcp(req:Request,res:Response,p:Principal,execution:ExecutionService){
 const handler=createMcpHandler(async()=>{
 const server=new Server({name:'OmniMCP',version:'0.1.0'},{capabilities:{tools:{}},supportedProtocolVersions:['2026-07-28']});
 server.setRequestHandler('tools/list',async()=>({tools:(await execution.list(p)).map(t=>({name:t.name,description:t.description,inputSchema:{...t.input_schema,type:'object' as const},annotations:{readOnlyHint:t.risk==='READ',destructiveHint:t.risk==='CRITICAL',openWorldHint:true}}))}));
 server.setRequestHandler('tools/call',async request=>{try{const outcome=await execution.call(p,request.params.name,request.params.arguments??{},req.get('idempotency-key'));return {content:[{type:'text' as const,text:JSON.stringify(outcome)}],structuredContent:outcome,isError:['failed','denied','rejected'].includes(outcome.status)};}catch(e){return {content:[{type:'text' as const,text:JSON.stringify(publicError(e))}],isError:true};}});
 return server;
 },{legacy:'reject',responseMode:'auto'});
 try{await toNodeHandler(handler)(req,res,req.body);}finally{await handler.close();}
}
