import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as migrations from '../db/migrations.js';
import { WalletService } from '../services/wallet-service.js';
import { buildMemoText, buildRevealMessage, LogDecisionOnChain } from './log-decision-on-chain.js';

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

describe('buildRevealMessage()', () => {
  it('produces exactly 3 lines', () => {
    const result = buildRevealMessage(
      'Yield rotation proposed.',
      '2026-04-07T14:23:01.000Z — Yield rotation Rule #3. Constitutional compliance: 100%.',
      'https://explorer.solana.com/tx/abc123?cluster=devnet',
    );
    expect(result.split('\n').length).toBe(3);
  });

  it('wraps memo text in backtick monospace on line 2', () => {
    const memoText = '2026-04-07T14:23:01.000Z — Yield rotation Rule #3. Constitutional compliance: 100%.';
    const result = buildRevealMessage('Action summary.', memoText, 'https://example.com/tx/abc');
    const lines = result.split('\n');
    expect(lines[1]).toMatch(/^\`.+\`$/);
  });

  it('places 🔗 explorerUrl on line 3', () => {
    const explorerUrl = 'https://example.com/tx/abc';
    const result = buildRevealMessage('Action summary.', 'memo text', explorerUrl);
    const lines = result.split('\n');
    expect(lines[2]).toBe(`🔗 ${explorerUrl}`);
  });

  it('handles long action summary without breaking structure', () => {
    const longSummary = 'A'.repeat(200);
    const result = buildRevealMessage(
      longSummary,
      'memo text here',
      'https://explorer.solana.com/tx/abc',
    );
    expect(result.split('\n').length).toBe(3);
  });

  it('truncates action summary longer than 80 chars with ellipsis', () => {
    const longSummary = 'A'.repeat(100);
    const result = buildRevealMessage(longSummary, 'memo', 'https://example.com');
    const line1 = result.split('\n')[0];
    expect(line1.length).toBeLessThanOrEqual(80);
    expect(line1.endsWith('…')).toBe(true);
  });

  it('keeps action summary ≤80 chars unchanged', () => {
    const summary = 'Short summary.';
    const result = buildRevealMessage(summary, 'memo', 'https://example.com');
    expect(result.split('\n')[0]).toBe(summary);
  });

  it('normalises embedded newlines/spaces so reveal message stays exactly 3 lines', () => {
    const result = buildRevealMessage(
      'Yield rotation proposed.\nMove 10%   from Kamino.',
      'memo text',
      'https://example.com',
    );
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Yield rotation proposed. Move 10% from Kamino.');
  });
});

describe('LogDecisionOnChain handler — DB persistence', () => {
  const prepareMock = mock(() => ({ run: runMock }));
  const runMock = mock(() => undefined);
  let getDbSpy: ReturnType<typeof spyOn>;
  let writeMemoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    runMock.mockClear();
    prepareMock.mockClear();
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({
      prepare: prepareMock,
    } as unknown as ReturnType<typeof migrations.getDb>);
  });

  afterEach(() => {
    getDbSpy.mockRestore();
    writeMemoSpy?.mockRestore();
  });

  it('inserts into on_chain_memos on success', async () => {
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'abc123',
      explorerUrl: 'https://explorer.solana.com/tx/abc123?cluster=devnet',
    });
    const callback = mock(async () => undefined);

    const result = await LogDecisionOnChain.handler?.(
      { sendMessageToTarget: mock(async () => undefined) } as never,
      {
        content: {
          actionDescription: 'Yield rotation proposed.',
          ruleReference: 'Rule #3',
          complianceStatus: 'Constitutional compliance: 100%.',
        },
        roomId: 'room-1',
      } as never,
      undefined,
      undefined,
      callback,
    );

    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE INTO on_chain_memos'));
    expect(runMock).toHaveBeenCalledWith(
      'abc123',
      'ACTION',
      expect.stringContaining('Yield rotation proposed.'),
      'https://explorer.solana.com/tx/abc123?cluster=devnet',
      expect.any(String),
    );
    expect(result).toMatchObject({ success: true });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('buildRevealMessage used in success callback produces correct DB-ready data', () => {
    const actionDescription = 'Yield rotation proposed: Move 10% from Kamino to Marginfi.';
    const memoText = '2026-04-07T14:23:01.000Z — Yield rotation Rule #3. Constitutional compliance: 100%.';
    const explorerUrl = 'https://explorer.solana.com/tx/5yRHk2?cluster=devnet';

    const reveal = buildRevealMessage(actionDescription, memoText, explorerUrl);
    const lines = reveal.split('\n');

    // Line 1: action summary (≤80 chars)
    expect(lines[0].length).toBeLessThanOrEqual(80);
    // Line 2: backtick-wrapped memo
    expect(lines[1]).toBe(`\`${memoText}\``);
    // Line 3: explorer link
    expect(lines[2]).toBe(`🔗 ${explorerUrl}`);
  });

  it('inserts failed row in on_chain_memos on RPC failure', async () => {
    writeMemoSpy = spyOn(WalletService, 'writeMemo')
      .mockRejectedValueOnce(new Error('RPC unavailable'))
      .mockResolvedValueOnce({
        txHash: 'error-memo',
        explorerUrl: 'https://explorer.solana.com/tx/error-memo?cluster=devnet',
      });
    const sendMessageToTarget = mock(async () => undefined);

    await expect(
      LogDecisionOnChain.handler?.(
        { sendMessageToTarget } as never,
        {
          content: {
            actionDescription: 'Swap executed.',
            ruleReference: 'Rule #1',
            complianceStatus: 'Constitutional compliance: 100%.',
          },
          roomId: 'room-1',
        } as never,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow('RPC unavailable');

    expect(runMock).toHaveBeenCalledWith(
      expect.stringMatching(/^FAILED_\d{4}-\d{2}-\d{2}T.*_[0-9a-f-]{36}$/),
      'ACTION',
      expect.stringContaining('Swap executed.'),
      expect.any(String),
    );
    expect(sendMessageToTarget).toHaveBeenCalledTimes(1);
  });

  it('NON_ACTION actionType is stored correctly', async () => {
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'non-action-1',
      explorerUrl: 'https://explorer.solana.com/tx/non-action-1?cluster=devnet',
    });

    await LogDecisionOnChain.handler?.(
      { sendMessageToTarget: mock(async () => undefined) } as never,
      {
        content: {
          actionDescription: 'User rejected yield rotation.',
          ruleReference: 'Rule #3',
          complianceStatus: 'Constitutional compliance: 100%.',
          actionType: 'NON_ACTION',
        },
        roomId: 'room-1',
      } as never,
      undefined,
      undefined,
      undefined,
    );

    expect(runMock).toHaveBeenCalledWith(
      'non-action-1',
      'NON_ACTION',
      expect.any(String),
      'https://explorer.solana.com/tx/non-action-1?cluster=devnet',
      expect.any(String),
    );
  });
});
