import { Ajv } from 'ajv';
import formats from 'ajv-formats';
import { AppError,type JsonObject } from '../../shared/src/index.js';
const ajv=new Ajv({allErrors:false,strict:false,validateFormats:true,addUsedSchema:false});
(formats as unknown as (a:Ajv)=>void)(ajv);
export function validateInput(schema:JsonObject,args:unknown): asserts args is JsonObject { let valid;try{valid=ajv.compile(schema);}catch{throw new AppError('INVALID_SCHEMA','Tool schema is invalid');}if(!valid(args))throw new AppError('INVALID_ARGUMENTS','Arguments do not match the tool input schema'); }
