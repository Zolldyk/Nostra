import type { AgentState, PendingProposal } from '../types/agent-state.js';
import type { DatabaseLike } from '../db/migrations.js';

// Extend DatabaseLike with query support for reads
interface ReadableDatabaseLike extends DatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
}

const DEFAULT_STATE: Omit<AgentState, 'updatedAt'> = {
  mode: 'paper',
  trustLadder: 'advisor',
  crisisStatus: 'active',
  constitutionVersion: 0,
  accuracyScore: 0,
  suggestionsSampled: 0,
  onboardingState: 'pending',
  referralSource: undefined,
  promotionPending: false,
  telegramChatId: undefined,
};

class AgentStateServiceImpl {
  private state: AgentState | null = null;

  async init(db: ReadableDatabaseLike): Promise<void> {
    const row = db.prepare('SELECT * FROM agent_state WHERE id = 1').get() as Record<string, unknown> | undefined;
    if (!row) {
      this.state = {
        ...DEFAULT_STATE,
        updatedAt: new Date().toISOString(),
      };
      this.persist(db);
    } else {
      this.state = this.fromRow(row);
    }
    this.state.pendingProposal = undefined;
  }

  getState(): AgentState {
    if (!this.state) {
      throw new Error('AgentStateService not initialised — call init() first');
    }
    return {
      ...this.state,
      pendingProposal: this.state.pendingProposal ? { ...this.state.pendingProposal } : undefined,
    };
  }

  async setState(update: Partial<AgentState>, db: ReadableDatabaseLike): Promise<void> {
    if (!this.state) {
      throw new Error('AgentStateService not initialised — call init() first');
    }
    this.state = { ...this.state, ...update, updatedAt: new Date().toISOString() };
    this.persist(db);
  }

  setPendingProposal(proposal: PendingProposal | undefined): void {
    if (!this.state) {
      throw new Error('AgentStateService not initialised — call init() first');
    }
    this.state = {
      ...this.state,
      pendingProposal: proposal ? { ...proposal } : undefined,
    };
  }

  private persist(db: ReadableDatabaseLike): void {
    const s = this.state!;
    db.prepare(`
      INSERT INTO agent_state
        (id, mode, trust_ladder, crisis_status, constitution_version, accuracy_score,
         suggestions_sampled, onboarding_state, referral_source, telegram_chat_id,
         promotion_pending, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        mode = excluded.mode,
        trust_ladder = excluded.trust_ladder,
        crisis_status = excluded.crisis_status,
        constitution_version = excluded.constitution_version,
        accuracy_score = excluded.accuracy_score,
        suggestions_sampled = excluded.suggestions_sampled,
        onboarding_state = excluded.onboarding_state,
        referral_source = excluded.referral_source,
        telegram_chat_id = excluded.telegram_chat_id,
        promotion_pending = excluded.promotion_pending,
        updated_at = excluded.updated_at
    `).run(
      s.mode,
      s.trustLadder,
      s.crisisStatus,
      s.constitutionVersion,
      s.accuracyScore,
      s.suggestionsSampled,
      s.onboardingState,
      s.referralSource ?? null,
      s.telegramChatId ?? null,
      s.promotionPending ? 1 : 0,
      s.updatedAt,
    );
  }

  private fromRow(row: Record<string, unknown>): AgentState {
    return {
      mode: row['mode'] as AgentState['mode'],
      trustLadder: row['trust_ladder'] as AgentState['trustLadder'],
      crisisStatus: row['crisis_status'] as AgentState['crisisStatus'],
      constitutionVersion: row['constitution_version'] as number,
      accuracyScore: row['accuracy_score'] as number,
      suggestionsSampled: row['suggestions_sampled'] as number,
      onboardingState: (row['onboarding_state'] ?? 'pending') as AgentState['onboardingState'],
      referralSource: (row['referral_source'] as string | undefined) ?? undefined,
      promotionPending: Boolean(row['promotion_pending']),
      telegramChatId: (row['telegram_chat_id'] as string | undefined) ?? undefined,
      updatedAt: row['updated_at'] as string,
    };
  }
}

export const AgentStateService = new AgentStateServiceImpl();
