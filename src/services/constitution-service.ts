import type { DatabaseLike } from '../db/migrations.js';
import type { ConstitutionRule } from '../types/constitution.js';

interface ReadableDb extends DatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

class ConstitutionServiceImpl {
  saveDraft(db: DatabaseLike, rules: ConstitutionRule[]): number {
    const rdb = db as ReadableDb;
    const rulesJson = JSON.stringify(rules);
    const result = rdb.prepare(
      `INSERT INTO constitution (version, rules_json, created_at, active) VALUES (?, ?, ?, ?)`,
    ).run(0, rulesJson, new Date().toISOString(), 0) as { lastInsertRowid: number };
    const constitutionId = Number(result.lastInsertRowid);
    for (let i = 0; i < rules.length; i++) {
      rdb.prepare(
        `INSERT INTO constitution_rules (constitution_id, rule_index, rule_json) VALUES (?, ?, ?)`,
      ).run(constitutionId, i, JSON.stringify(rules[i]));
    }
    return constitutionId;
  }

  getDraft(db: DatabaseLike): { id: number; rules: ConstitutionRule[] } | null {
    const rdb = db as ReadableDb;
    const row = rdb.prepare(
      `SELECT * FROM constitution WHERE version = 0 ORDER BY id DESC LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const id = row['id'] as number;
    const ruleRows = rdb.prepare(
      `SELECT rule_json FROM constitution_rules WHERE constitution_id = ? ORDER BY rule_index ASC`,
    ).all(id) as Record<string, unknown>[];
    const rules = ruleRows.map((r, i) => {
      const rule = JSON.parse(r['rule_json'] as string) as ConstitutionRule;
      rule.id = i + 1;
      return rule;
    });
    return { id, rules };
  }

  updateDraftRule(db: DatabaseLike, constitutionId: number, ruleIndex: number, rule: ConstitutionRule): void {
    const rdb = db as ReadableDb;
    rdb.prepare(
      `UPDATE constitution_rules SET rule_json = ? WHERE constitution_id = ? AND rule_index = ?`,
    ).run(JSON.stringify(rule), constitutionId, ruleIndex);
    // Refresh rules_json on constitution row
    const allRules = rdb.prepare(
      `SELECT rule_json FROM constitution_rules WHERE constitution_id = ? ORDER BY rule_index ASC`,
    ).all(constitutionId) as Record<string, unknown>[];
    const merged = allRules.map(r => JSON.parse(r['rule_json'] as string) as ConstitutionRule);
    rdb.prepare(`UPDATE constitution SET rules_json = ? WHERE id = ?`).run(
      JSON.stringify(merged),
      constitutionId,
    );
  }

  appendDraftRule(db: DatabaseLike, constitutionId: number, rule: ConstitutionRule): void {
    const rdb = db as ReadableDb;
    const countRow = rdb.prepare(
      `SELECT COUNT(*) as cnt FROM constitution_rules WHERE constitution_id = ?`,
    ).get(constitutionId) as Record<string, unknown>;
    const nextIndex = countRow['cnt'] as number;
    rdb.prepare(
      `INSERT INTO constitution_rules (constitution_id, rule_index, rule_json) VALUES (?, ?, ?)`,
    ).run(constitutionId, nextIndex, JSON.stringify(rule));
    // Refresh rules_json
    const allRules = rdb.prepare(
      `SELECT rule_json FROM constitution_rules WHERE constitution_id = ? ORDER BY rule_index ASC`,
    ).all(constitutionId) as Record<string, unknown>[];
    const merged = allRules.map(r => JSON.parse(r['rule_json'] as string) as ConstitutionRule);
    rdb.prepare(`UPDATE constitution SET rules_json = ? WHERE id = ?`).run(
      JSON.stringify(merged),
      constitutionId,
    );
  }

  activateDraft(db: DatabaseLike, constitutionId: number): void {
    const rdb = db as ReadableDb;
    rdb.prepare(`UPDATE constitution SET active = 0`).run();
    rdb.prepare(`UPDATE constitution SET active = 1, version = 1 WHERE id = ?`).run(constitutionId);
  }

  getActive(db: DatabaseLike): { id: number; version: number; rules: ConstitutionRule[] } | null {
    const rdb = db as ReadableDb;
    const row = rdb.prepare(
      `SELECT * FROM constitution WHERE active = 1 LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const id = row['id'] as number;
    const version = row['version'] as number;
    const ruleRows = rdb.prepare(
      `SELECT rule_json FROM constitution_rules WHERE constitution_id = ? ORDER BY rule_index ASC`,
    ).all(id) as Record<string, unknown>[];
    const rules = ruleRows.map((r, i) => {
      const rule = JSON.parse(r['rule_json'] as string) as ConstitutionRule;
      rule.id = i + 1;
      return rule;
    });
    return { id, version, rules };
  }
}

export const ConstitutionService = new ConstitutionServiceImpl();
