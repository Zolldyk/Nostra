export interface LamportMemo {
  txHash: string;
  actionType: 'ACTION' | 'NON_ACTION' | 'CRISIS_FREEZE' | 'AMENDMENT';
  memoText: string;     // The exact string written on-chain (≤500 chars)
  explorerUrl: string;
  createdAt: string;    // ISO 8601
}
