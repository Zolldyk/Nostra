export interface NosanaComputeCost {
  spentNos: number;
  monthLabel: string;
}

export async function fetchMonthlyComputeCost(): Promise<NosanaComputeCost> {
  const apiKey = process.env.NOSANA_API_KEY;
  if (!apiKey) {
    throw new Error('NOSANA_API_KEY not configured');
  }

  // TODO(Story 6.2): Replace this stub with a real Nosana compute-cost integration.
  // Nosana usage/billing is exposed through on-chain contracts, the dashboard, and SDK/CLI
  // workflows rather than a documented REST billing endpoint we can safely depend on here.
  throw new Error('Nosana compute cost integration not available yet');
}
