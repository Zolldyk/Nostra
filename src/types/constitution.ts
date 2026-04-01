export interface ConstitutionRule {
  id: number;          // Rule #N (1-indexed, matches on-chain memo references)
  type: 'allocation_limit' | 'yield_threshold' | 'action_gate' | 'compute_budget' | 'custom';
  description: string; // Plain-English — used verbatim in Lamport memos
  condition: {
    metric: string;    // e.g. "sol_concentration", "yield_delta", "compute_cost_nos"
    operator: '<' | '>' | '<=' | '>=' | '==' | '!=';
    value: number;
    unit: string;      // e.g. "percent", "apy_points", "nos_tokens"
  };
  action: 'block' | 'alert' | 'require_approval' | 'reduce_frequency';
}
