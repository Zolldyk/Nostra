import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import * as migrations from '../db/migrations.js';
import { AgentStateService } from '../services/agent-state-service.js';
import { recomputeTrustLadder } from './trust-ladder-evaluator.js';

const mockRuntime = {} as IAgentRuntime;

describe('recomputeTrustLadder', () => {
  let getDbSpy: ReturnType<typeof spyOn>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let setStateSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    getDbSpy?.mockRestore();
    getStateSpy?.mockRestore();
    setStateSpy?.mockRestore();
  });

  it('persists accuracy score and sample count from graded rows', async () => {
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({
      prepare: mock(() => ({
        all: mock(() => [{ user_grade: 1 }, { user_grade: 0 }, { user_grade: 1 }]),
      })),
    } as unknown as ReturnType<typeof migrations.getDb>);
    setStateSpy = spyOn(AgentStateService, 'setState').mockResolvedValue(undefined);

    await recomputeTrustLadder(mockRuntime);

    expect(setStateSpy).toHaveBeenCalledTimes(1);
    expect(setStateSpy.mock.calls[0]?.[0]).toEqual({
      accuracyScore: (2 / 3) * 100,
      suggestionsSampled: 3,
    });
  });

  it('sets promotionPending when threshold is reached with meaningful sample size', async () => {
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({
      prepare: mock(() => ({
        all: mock(() => [
          { user_grade: 1 },
          { user_grade: 1 },
          { user_grade: 1 },
          { user_grade: 1 },
          { user_grade: 0 },
        ]),
      })),
    } as unknown as ReturnType<typeof migrations.getDb>);
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 1,
      accuracyScore: 0,
      suggestionsSampled: 0,
      onboardingState: 'complete',
      promotionPending: false,
      updatedAt: new Date().toISOString(),
    });
    setStateSpy = spyOn(AgentStateService, 'setState').mockResolvedValue(undefined);

    await recomputeTrustLadder(mockRuntime);

    expect(setStateSpy.mock.calls[0]?.[0]).toEqual({
      accuracyScore: 80,
      suggestionsSampled: 5,
      promotionPending: true,
    });
  });
});
