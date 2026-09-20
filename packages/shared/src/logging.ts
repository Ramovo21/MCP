import pino from 'pino';
/** Only explicit metadata is passed here. No request/response objects or error stacks. */
export const logger = pino({
  redact: ['authorization', 'password', 'token', 'secrets', 'arguments', 'result'],
});
