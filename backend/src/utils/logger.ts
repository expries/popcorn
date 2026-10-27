import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const currentLogLevel: LogLevel =
  (process.env.LOG_LEVEL?.toUpperCase() as LogLevel) || 'DEBUG';

const LOG_DIR = process.env.LOG_DIR || join(process.cwd(), 'logs');
const LOG_TO_FILE = process.env.LOG_TO_FILE !== 'false';

// Ensure log directory exists
if (LOG_TO_FILE && !existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFilePath(): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return join(LOG_DIR, `app-${date}.log`);
}

function getTimestamp(): string {
  return new Date().toISOString();
}

function formatLogLine(
  level: LogLevel,
  context: string,
  message: string,
  args: unknown[],
): string {
  const timestamp = getTimestamp();
  const argsStr = args.length > 0
    ? ' ' + args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') {
          try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
      }).join(' ')
    : '';
  return `${timestamp} [${level}] [${context}] ${message}${argsStr}`;
}

function writeToFile(line: string): void {
  if (!LOG_TO_FILE) return;
  try {
    appendFileSync(getLogFilePath(), line + '\n');
  } catch {
    // Silently fail if we can't write to file
  }
}

function formatMessage(
  level: LogLevel,
  context: string,
  message: string,
  ...args: unknown[]
): [string, ...unknown[]] {
  const timestamp = getTimestamp();
  const prefix = `${timestamp} [${level}] [${context}]`;
  return [`${prefix} ${message}`, ...args];
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

function createLogger(context: string) {
  return {
    debug(message: string, ...args: unknown[]) {
      if (shouldLog('DEBUG')) {
        console.log(...formatMessage('DEBUG', context, message, ...args));
        writeToFile(formatLogLine('DEBUG', context, message, args));
      }
    },
    info(message: string, ...args: unknown[]) {
      if (shouldLog('INFO')) {
        console.log(...formatMessage('INFO', context, message, ...args));
        writeToFile(formatLogLine('INFO', context, message, args));
      }
    },
    warn(message: string, ...args: unknown[]) {
      if (shouldLog('WARN')) {
        console.warn(...formatMessage('WARN', context, message, ...args));
        writeToFile(formatLogLine('WARN', context, message, args));
      }
    },
    error(message: string, ...args: unknown[]) {
      if (shouldLog('ERROR')) {
        console.error(...formatMessage('ERROR', context, message, ...args));
        writeToFile(formatLogLine('ERROR', context, message, args));
      }
    },
  };
}

export { createLogger, type LogLevel };
