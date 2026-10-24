// Whitelist diagnostic metadata rather than logging messages/query text/URLs with secrets.
export function errorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return { errorType: 'UnknownError' };
  const value = error as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  for (const key of ['name', 'code', 'syscall', 'address', 'port', 'statusCode']) {
    const field = value[key];
    if (typeof field === 'number' || (typeof field === 'string' && /^[a-zA-Z0-9_.:\-]{1,100}$/.test(field))) details[key] = field;
  }
  if (value.cause && value.cause !== error) {
    const cause = value.cause as Record<string, unknown>;
    if (typeof cause.code === 'string' && /^[a-zA-Z0-9_]{1,40}$/.test(cause.code)) details.causeCode = cause.code;
  }
  if (Array.isArray(value.errors)) {
    details.connections = value.errors.slice(0, 4).map((entry) => {
      const connection = entry as Record<string, unknown>;
      return Object.fromEntries(['code', 'address', 'port'].flatMap((key) => {
        const field = connection?.[key];
        return typeof field === 'number' || (typeof field === 'string' && /^[a-zA-Z0-9_.:\-]{1,100}$/.test(field)) ? [[key, field]] : [];
      }));
    });
  }
  return details;
}

export function endpointAddress(url: string): string {
  const endpoint = new URL(url);
  return `${endpoint.protocol}//${endpoint.hostname}${endpoint.port ? `:${endpoint.port}` : ''}`;
}
