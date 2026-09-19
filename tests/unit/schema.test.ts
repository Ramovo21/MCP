import { test, expect } from 'vitest';
import { validateToolSchema, validateInput } from '../../packages/mcp-core/src/validation.js';
test('MCP JSON Schema 2020-12 validates prefixItems and unevaluated properties', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { values: { type: 'array', prefixItems: [{ type: 'integer' }], items: false } },
    required: ['values'],
    unevaluatedProperties: false,
  };
  expect(() => validateToolSchema(schema)).not.toThrow();
  expect(() => validateInput(schema, { values: [1] })).not.toThrow();
  expect(() => validateInput(schema, { values: ['wrong'] })).toThrow(/Arguments/);
  expect(() => validateInput(schema, { values: [1], extra: true })).toThrow(/Arguments/);
});
test('explicit draft-07 tools remain compatible', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { count: { type: 'integer', minimum: 1 } },
    required: ['count'],
    additionalProperties: false,
  };
  expect(() => validateToolSchema(schema)).not.toThrow();
  expect(() => validateInput(schema, { count: 0 })).toThrow();
  expect(() => validateInput(schema, { count: 1 })).not.toThrow();
});
