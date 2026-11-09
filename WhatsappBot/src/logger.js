/**
 * Single pino instance for the app, plus a quieter child for Baileys.
 *
 * Message bodies are never logged. Where a message has to be referenced at all
 * we log its chat JID and its length, nothing else.
 */
import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: undefined, // drop pid/hostname noise
  redact: {
    paths: ['apiKey', 'text', 'body', 'question', 'answer'],
    censor: '[redacted]',
  },
});

/** Baileys is extremely chatty at info level; keep it at warn and above. */
export const baileysLogger = pino({ level: 'warn', base: undefined });
