const CONTEXT_WINDOW_ERROR_RE =
  /context window|context length|too many tokens|token limit|input too large|maximum context|maximum input length/i;

export function isContextWindowError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return CONTEXT_WINDOW_ERROR_RE.test(text);
}
