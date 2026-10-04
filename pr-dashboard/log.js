const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function serializeError(error) {
  if (!(error instanceof Error)) return { message: String(error) };

  const { cause, ...details } = error;
  return {
    name: error.name,
    message: error.message,
    ...details,
    stack: error.stack,
    ...(cause ? { cause: serializeError(cause) } : {}),
  };
}

function createLogger({ level = 'info', fields = {}, write } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit =
    write ||
    ((line, levelName) => (levelName === 'error' || levelName === 'warn' ? process.stderr : process.stdout).write(`${line}\n`));

  function log(levelName, msg, extra = {}) {
    if (LEVELS[levelName] < threshold) return;
    const entry = { time: new Date().toISOString(), level: levelName, msg, ...fields };
    for (const [key, value] of Object.entries(extra)) {
      entry[key] = value instanceof Error ? serializeError(value) : value;
    }
    emit(JSON.stringify(entry), levelName);
  }

  return {
    debug: (msg, extra) => log('debug', msg, extra),
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    child: (more) => createLogger({ level, fields: { ...fields, ...more }, write }),
  };
}

export { createLogger, serializeError };
