import { pino, type Logger } from 'pino';
import type { LogLevel } from './config.js';

/** JSON logger for the worker and subscriber processes. */
export function createLogger(name: string, level: LogLevel): Logger {
  return pino({ name, level });
}
