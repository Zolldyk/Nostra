import cron from 'node-cron';
import type { IAgentRuntime } from '@elizaos/core';
import { generateMorningBriefing } from '../actions/generate-morning-briefing.js';
import { generateEveningReport } from '../actions/generate-evening-report.js';
import { generateStorytellerChapter } from '../actions/generate-storyteller-chapter.js';

export function startBriefingScheduler(runtime: unknown): void {
  const rt = runtime as IAgentRuntime;

  // Morning briefing: 7am daily — Story 3.5
  // Note: node-cron uses process timezone (UTC in Docker). Set TZ env var in Nosana job definition for local time.
  cron.schedule('0 7 * * *', async () => {
    try {
      await generateMorningBriefing(rt);
    } catch (err) {
      console.error('[BriefingScheduler] Morning briefing error:', err instanceof Error ? err.message : String(err));
    }
  });

  // Evening report: 10pm daily — Story 3.6
  // Note: node-cron uses process timezone (UTC in Docker). Set TZ env var in Nosana job definition for local time.
  cron.schedule('0 22 * * *', async () => {
    try {
      await generateEveningReport(rt);
    } catch (err) {
      console.error('[BriefingScheduler] Evening report error:', err instanceof Error ? err.message : String(err));
    }
  });

  // Storyteller chapter: Sunday 10am — Story 6.1
  // Note: node-cron uses process timezone (UTC in Docker). Set TZ env var in Nosana job definition for local time.
  cron.schedule('0 10 * * 0', async () => {
    try {
      await generateStorytellerChapter(rt);
    } catch (err) {
      console.error('[BriefingScheduler] Storyteller chapter error:', err instanceof Error ? err.message : String(err));
    }
  });
}
