export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 5000,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  // unreachable — TypeScript requires explicit throw
  throw new Error('unreachable');
}
