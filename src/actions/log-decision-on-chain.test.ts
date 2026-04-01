import { describe, it, expect } from 'bun:test';
import { buildMemoText } from './log-decision-on-chain.js';

const MEMO_MAX_CHARS = 500;

describe('buildMemoText()', () => {
  it('produces memo within 500 char limit for normal inputs', () => {
    const memo = buildMemoText({
      actionDescription: 'Rotated 12% from Kamino to Marginfi per yield delta +2.1%.',
      ruleReference: 'Rule #3',
      complianceStatus: 'Constitutional compliance: 100%.',
    });
    expect(memo.length).toBeLessThanOrEqual(MEMO_MAX_CHARS);
  });

  it('always starts with ISO timestamp', () => {
    const memo = buildMemoText({
      actionDescription: 'Test action.',
      ruleReference: 'Rule #1',
      complianceStatus: 'Constitutional compliance: 100%.',
    });
    // ISO 8601 pattern: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(memo).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('always ends with compliance status', () => {
    const complianceStatus = 'Constitutional compliance: 100%.';
    const memo = buildMemoText({
      actionDescription: 'Test.',
      ruleReference: 'Rule #0',
      complianceStatus,
    });
    expect(memo.endsWith(complianceStatus)).toBe(true);
  });

  it('always includes rule reference', () => {
    const memo = buildMemoText({
      actionDescription: 'Test.',
      ruleReference: 'Rule #5',
      complianceStatus: 'Constitutional compliance: 100%.',
    });
    expect(memo).toContain('Rule #5');
  });

  it('truncates long action description — never truncates timestamp or compliance status', () => {
    const longDesc = 'A'.repeat(600);
    const ruleReference = 'Rule #0';
    const complianceStatus = 'Constitutional compliance: 100%.';

    const memo = buildMemoText({ actionDescription: longDesc, ruleReference, complianceStatus });

    expect(memo.length).toBeLessThanOrEqual(MEMO_MAX_CHARS);
    expect(memo).toContain(ruleReference);
    expect(memo.endsWith(complianceStatus)).toBe(true);
    expect(memo).toMatch(/^\d{4}-\d{2}-\d{2}T/); // timestamp still present
  });

  it('uses Rule #0 and system init status for default memo', () => {
    const memo = buildMemoText({
      actionDescription: 'System initialisation complete. AgentStateService online.',
      ruleReference: 'Rule #0',
      complianceStatus: 'System initialisation.',
    });
    expect(memo).toContain('Rule #0');
    expect(memo).toContain('System initialisation');
  });

  it('matches exact format: TIMESTAMP — DESCRIPTION RULE. STATUS.', () => {
    const memo = buildMemoText({
      actionDescription: 'No action taken.',
      ruleReference: 'Rule #2',
      complianceStatus: 'Constitutional compliance: 100%.',
    });
    // Format: {timestamp} — {desc} {rule}. {status}
    expect(memo).toMatch(/^.+ — .+ Rule #\d+\. .+$/);
  });
});
