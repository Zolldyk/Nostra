import type { DatabaseLike } from '../db/migrations.js';

export interface OnboardingTurn {
  id: number;
  role: 'agent' | 'user';
  content: string;
  phase: 'questions' | 'summary' | 'contradiction' | 'constitution_display';
  createdAt: string;
}

function fromRow(row: Record<string, unknown>): OnboardingTurn {
  return {
    id: row['id'] as number,
    role: row['role'] as 'agent' | 'user',
    content: row['content'] as string,
    phase: row['phase'] as 'questions' | 'summary' | 'contradiction' | 'constitution_display',
    createdAt: row['created_at'] as string,
  };
}

class OnboardingServiceImpl {
  addTurn(db: DatabaseLike, role: 'agent' | 'user', content: string, phase: 'questions' | 'summary' | 'contradiction' | 'constitution_display'): void {
    db.prepare(
      `INSERT INTO onboarding_session (role, content, phase, created_at) VALUES (?, ?, ?, ?)`,
    ).run(role, content, phase, new Date().toISOString());
  }

  getHistory(db: DatabaseLike): OnboardingTurn[] {
    const rows = (db as unknown as { prepare(sql: string): { all(...params: unknown[]): unknown[] } })
      .prepare('SELECT * FROM onboarding_session ORDER BY id ASC')
      .all();
    return (rows as Record<string, unknown>[]).map(fromRow);
  }

  countUserAnswers(db: DatabaseLike): number {
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM onboarding_session WHERE role = 'user'`,
    ).get() as Record<string, unknown>;
    return row['count'] as number;
  }

  getLastTurn(db: DatabaseLike): OnboardingTurn | null {
    const row = db.prepare(
      `SELECT * FROM onboarding_session ORDER BY id DESC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return fromRow(row);
  }

  clearSession(db: DatabaseLike): void {
    db.prepare('DELETE FROM onboarding_session').run();
  }
}

export const OnboardingService = new OnboardingServiceImpl();
