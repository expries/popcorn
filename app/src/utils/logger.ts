type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

function getLogLevelFromEnv(): LogLevel {
  try {
    const envLevel = import.meta.env?.VITE_LOG_LEVEL?.toUpperCase();
    if (envLevel && envLevel in LOG_LEVELS) {
      return envLevel as LogLevel;
    }
  } catch {
    // import.meta.env may not be available in all contexts
  }
  return 'DEBUG';
}

const currentLogLevel: LogLevel = getLogLevelFromEnv();

function getTimestamp(): string {
  return new Date().toISOString();
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
      }
    },
    info(message: string, ...args: unknown[]) {
      if (shouldLog('INFO')) {
        console.log(...formatMessage('INFO', context, message, ...args));
      }
    },
    warn(message: string, ...args: unknown[]) {
      if (shouldLog('WARN')) {
        console.warn(...formatMessage('WARN', context, message, ...args));
      }
    },
    error(message: string, ...args: unknown[]) {
      if (shouldLog('ERROR')) {
        console.error(...formatMessage('ERROR', context, message, ...args));
      }
    },
  };
}

export { createLogger, type LogLevel };
