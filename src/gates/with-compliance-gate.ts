// Stub — full implementation in Story 4.1
export async function withComplianceGate<T>(
  _ruleRef: string,
  fn: () => Promise<T>,
): Promise<T> {
  return fn();
}
