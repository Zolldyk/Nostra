import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { IAgentRuntime, Memory } from '@elizaos/core';
import * as migrations from '../db/migrations.js';
import { AgentStateService } from '../services/agent-state-service.js';
import * as trustLadderEvaluator from './trust-ladder-evaluator.js';
import { GradeSuggestionEvaluator } from './grade-suggestion-evaluator.js';

function mockMsg(text: string): Memory {
  return { content: { text, source: 'telegram' }, roomId: 'room-9' } as unknown as Memory;
}

const mockRuntime = {
  sendMessageToTarget: mock(async () => []),
} as unknown as IAgentRuntime;

describe('GradeSuggestionEvaluator', () => {
  let getDbSpy: ReturnType<typeof spyOn>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let recomputeSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    getDbSpy?.mockRestore();
    getStateSpy?.mockRestore();
    recomputeSpy?.mockRestore();
    mockRuntime.sendMessageToTarget.mockClear();
  });

  it('validate accepts only grade_good and grade_bad', async () => {
    expect(await GradeSuggestionEvaluator.validate!(mockRuntime, mockMsg('grade_good'))).toBe(true);
    expect(await GradeSuggestionEvaluator.validate!(mockRuntime, mockMsg('grade_bad'))).toBe(true);
    expect(await GradeSuggestionEvaluator.validate!(mockRuntime, mockMsg('grade_maybe'))).toBe(false);
  });

  it('silently ignores grading when no pending suggestion exists', async () => {
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({
      prepare: mock(() => ({
        get: mock(() => undefined),
        run: mock(() => undefined),
      })),
    } as unknown as ReturnType<typeof migrations.getDb>);

    await GradeSuggestionEvaluator.handler!(mockRuntime, mockMsg('grade_good'));

    expect(mockRuntime.sendMessageToTarget).not.toHaveBeenCalled();
  });

  it('updates the most recent pending suggestion, recomputes trust ladder, and confirms via runtime target', async () => {
    const runMock = mock(() => undefined);
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({
      prepare: mock((sql: string) => {
        if (sql.includes(`SELECT id, suggestion_id FROM trust_ladder_log`)) {
          return { get: mock(() => ({ id: 42, suggestion_id: 'suggestion-42' })), run: runMock };
        }
        if (sql.includes(`UPDATE trust_ladder_log SET user_grade = ?, status = 'graded'`)) {
          return { get: mock(() => undefined), run: runMock };
        }
        return { get: mock(() => undefined), run: runMock };
      }),
    } as unknown as ReturnType<typeof migrations.getDb>);
    recomputeSpy = spyOn(trustLadderEvaluator, 'recomputeTrustLadder').mockResolvedValue(undefined);
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 1,
      accuracyScore: 80,
      suggestionsSampled: 5,
      onboardingState: 'complete',
      promotionPending: true,
      telegramChatId: 'chat-777',
      updatedAt: new Date().toISOString(),
    });

    await GradeSuggestionEvaluator.handler!(mockRuntime, mockMsg('grade_good'));

    expect(runMock).toHaveBeenCalledWith(1, 42);
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
    expect(mockRuntime.sendMessageToTarget).toHaveBeenCalledTimes(1);
    expect(mockRuntime.sendMessageToTarget.mock.calls[0]?.[0]).toEqual({ source: 'telegram', roomId: 'room-9' });
    const payload = mockRuntime.sendMessageToTarget.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain('✅ Grade recorded.');
    expect(payload.text).toContain('Accuracy: 80.0% across 5 suggestions.');
    expect(payload.text).toContain('🏆');
  });
});
