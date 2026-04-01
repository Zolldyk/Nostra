const USER_FRIENDLY_PREFIX = '⚠️ Nostra encountered an unexpected issue.\n\n';

export function formatErrorMessage(error: unknown): string {
  // Never expose raw stack traces to the user
  const message = error instanceof Error ? error.message : 'An unknown error occurred';
  // Strip any path or stack fragments that might leak internals
  const sanitised = message.replace(/\bat\b.*/gs, '').trim();
  return `${USER_FRIENDLY_PREFIX}${sanitised}\n\nI've logged this on-chain and will not proceed until you review.`;
}

export async function handleActionError(
  sendUserMessage: (message: string) => Promise<void>,
  writeNonActionMemo: () => Promise<void>,
  error: unknown,
): Promise<never> {
  // Step 1: Write non-action Lamport memo FIRST — MUST complete before step 2
  await writeNonActionMemo();

  // Step 2: Notify user via Telegram
  await sendUserMessage(formatErrorMessage(error));

  // Step 3: Re-throw — NEVER swallow
  throw error;
}
