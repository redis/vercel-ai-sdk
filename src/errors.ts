/** Safe error details suitable for an AI SDK tool result. Never attach upstream bodies or headers. */
export class RedisAgentMemoryToolError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode?: number) {
    super(message); this.name = 'IrisToolError';
  }
}

/** Share safe SDK error handling between model tools and application hooks. */
const statusGuidance: Record<number, string> = {
  409: 'The resource already exists, or the idempotencyKey was already used for a different request. Use a new key for a different request.',
  412: 'The memory changed after expectedRevision was read, so nothing was written. Call get_memory for the current revision, reapply the change to it, and send that revision as expectedRevision.',
};

export function sanitizeMemoryError(error: unknown): RedisAgentMemoryToolError {
  if (error instanceof RedisAgentMemoryToolError) return error;
  const code = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode : undefined;
  return new RedisAgentMemoryToolError(code ? `IRIS_HTTP_${code}` : 'IRIS_REQUEST_FAILED',
    code ? `Iris request failed (HTTP ${code}). ${statusGuidance[code] ?? 'Check service configuration and request scope. Writes may have partially succeeded; verify before retrying.'}`
      : 'Iris request failed. Check connectivity and service configuration. Verify writes before retrying.', code);
}
