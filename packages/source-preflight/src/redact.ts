const SENSITIVE_QUERY_KEYS = new Set(["token", "api_key", "apikey", "key", "authorization"]);

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return raw.replace(/(token|api[_-]?key|authorization)=([^&\s]+)/giu, "$1=[REDACTED]");
  }
}

export function redactText(raw: string, secrets: string[]): string {
  let value = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/(0x-api-key|x-api-key|api[_-]?key|token)(["'=:\s]+)[A-Za-z0-9._~+/=-]+/giu, "$1$2[REDACTED]");
  for (const secret of secrets.filter((candidate) => candidate.length >= 4)) value = value.split(secret).join("[REDACTED]");
  return value;
}

export function safeError(reason: unknown, secrets: string[]): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return redactText(message, secrets).slice(0, 240);
}
