import { z } from 'zod';
export const risks = ['READ','WRITE','SENSITIVE','CRITICAL'] as const;
export type Risk = typeof risks[number];
export type Role = 'owner'|'admin'|'developer'|'viewer';
export type JsonObject = Record<string, unknown>;
export interface Principal { organizationId: string; userId?: string; apiKeyId?: string; role: Role; scopes?: string[] }
export interface ToolRecord { id: string; organization_id: string; connection_id: string; name: string; description: string; input_schema: JsonObject; risk: Risk; baseline_risk: Risk; enabled: boolean; config: JsonObject }
export interface Connection { id: string; organization_id: string; name: string; connector_id: string; status: 'active'|'disabled'|'revoked'; config: JsonObject }
export const uuid = z.string().uuid();
export const toolName = z.string().regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/).max(128);
export class AppError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }
export function assertAdmin(p: Principal) { if(p.apiKeyId || !['owner','admin'].includes(p.role)) throw new AppError('FORBIDDEN','Organization administrator required',403); }
export function publicError(error: unknown) { return error instanceof AppError ? {code:error.code,message:error.message} : {code:'INTERNAL_ERROR',message:'The operation could not be completed'}; }
