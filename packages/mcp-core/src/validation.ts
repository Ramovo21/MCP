import { Ajv } from 'ajv';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError, type JsonObject } from '../../shared/src/index.js';
import { hash, canonical } from '../../shared/src/secrets.js';
const options = {
  allErrors: false,
  strict: false,
  validateFormats: true,
  addUsedSchema: false,
  logger: false as const,
};
const modern = new Ajv2020(options),
  legacy = new Ajv(options),
  cache = new Map<string, ValidateFunction>();
for (const validator of [modern, legacy])
  (formats as unknown as (a: Ajv | Ajv2020) => void)(validator);
function compile(schema: JsonObject) {
  const key = hash(canonical(schema)),
    cached = cache.get(key);
  if (cached) return cached;
  const validator = String(schema.$schema ?? '').includes('draft-07') ? legacy : modern;
  const result = validator.compile(schema);
  validator.removeSchema(schema);
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
export function validateToolSchema(schema: JsonObject) {
  if (schema.type !== 'object' || JSON.stringify(schema).length > 100000)
    throw new AppError('INVALID_SCHEMA', 'Tool input schema must be an object under 100 KB');
  try {
    compile(schema);
  } catch {
    throw new AppError('INVALID_SCHEMA', 'Tool schema is invalid or has unsupported references');
  }
}
export function validateInput(schema: JsonObject, args: unknown): asserts args is JsonObject {
  let valid;
  try {
    valid = compile(schema);
  } catch {
    throw new AppError('INVALID_SCHEMA', 'Tool schema is invalid');
  }
  if (!valid(args))
    throw new AppError('INVALID_ARGUMENTS', 'Arguments do not match the tool input schema');
}
