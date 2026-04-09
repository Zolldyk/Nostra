export const LIVE_PREFIX = '🔐 LIVE TREASURY';

export function prependLivePrefix(text: string): string {
  return `${LIVE_PREFIX}\n\n${text}`;
}

export function isLivePrefixed(text: string): boolean {
  return text.startsWith(LIVE_PREFIX);
}
