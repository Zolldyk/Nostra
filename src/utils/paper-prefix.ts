export const PAPER_PREFIX = '✈️ PAPER TREASURY SIMULATION';

export function prependPaperPrefix(text: string): string {
  return `${PAPER_PREFIX}\n\n${text}`;
}

export function isPaperPrefixed(text: string): boolean {
  return text.startsWith(PAPER_PREFIX);
}
