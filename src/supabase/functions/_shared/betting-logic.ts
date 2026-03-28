interface BettingConfig {
  totalTiles: number; // 25
  mineCount: number;  // 1-24
  houseEdge: number;  // e.g., 0.03 for 3%
}

/**
 * Calculates the multiplier for the next successful tile flip.
 * @param tilesFlipped - How many gems have already been found.
 * @param config - The game configuration.
 */
export function calculateNextMultiplier(
  tilesFlipped: number, 
  config: BettingConfig
): number {
  const { totalTiles, mineCount, houseEdge } = config;
  const safeTilesRemaining = totalTiles - mineCount - tilesFlipped;

  // Probability of hitting a gem on the next click
  const probability = safeTilesRemaining / (totalTiles - tilesFlipped);

  // The fair multiplier is 1 / probability. 
  // We apply the house edge to the payout.
  const multiplier = (1 / probability) * (1 - houseEdge);

  return parseFloat(multiplier.toFixed(4));
}

/**
 * Calculates the total payout for the current round state.
 */
export function calculateTotalPayout(
  betAmount: number, 
  tilesFlipped: number, 
  config: BettingConfig
): number {
  let currentMultiplier = 1;
  
  for (let i = 0; i < tilesFlipped; i++) {
    // We calculate the multiplier step-by-step to mimic the game loop
    const safeTilesAtStep = config.totalTiles - config.mineCount - i;
    const probabilityAtStep = safeTilesAtStep / (config.totalTiles - i);
    currentMultiplier *= (1 / probabilityAtStep);
  }

  const finalPayout = betAmount * currentMultiplier * (1 - config.houseEdge);
  return parseFloat(finalPayout.toFixed(8));
}
