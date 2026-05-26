/**
 * Aegis Slots — Three-reel, three-payline game engine
 *
 * RTP: 97.995%  (exact: 32111/32768)
 * Win rate per spin: ~7.91%
 *
 * Strip (32 virtual stops per reel, independent per cell):
 *   USDC=9  Moon=7  BTC=6  ETH=5  Diamond=3  Rocket=2
 *
 * Paytable (per-line bet multiplier):
 *   3-of-a-kind:  USDC=6x  Moon=15x  BTC=24x  ETH=41x  Diamond=180x  Rocket=650x
 *   2-of-a-kind:  Diamond pair=1x   Rocket pair=4x
 *
 * Each reel shows 3 rows.  Paylines read across the grid:
 *   Payline 0 (top row):    grid[0][0], grid[1][0], grid[2][0]
 *   Payline 1 (center row): grid[0][1], grid[1][1], grid[2][1]
 *   Payline 2 (bottom row): grid[0][2], grid[1][2], grid[2][2]
 *
 * The bet is divided equally across all 3 paylines.
 * Total payout = sum of winning payline payouts.
 */

import crypto from 'node:crypto';

// ─── Symbol definitions ──────────────────────────────────────────────────────

export const SYMBOLS = [
  { id: 'usdc',    emoji: '💵', label: 'USDC',    weight: 9 },
  { id: 'moon',    emoji: '🌙', label: 'MOON',    weight: 7 },
  { id: 'btc',     emoji: '₿',  label: 'BTC',     weight: 6 },
  { id: 'eth',     emoji: 'Ξ',  label: 'ETH',     weight: 5 },
  { id: 'diamond', emoji: '💎', label: 'DIAMOND', weight: 3 },
  { id: 'rocket',  emoji: '🚀', label: 'ROCKET',  weight: 2 },
];

const TOTAL_WEIGHT = SYMBOLS.reduce((s, sym) => s + sym.weight, 0); // 32

// Cumulative weight thresholds for weighted sampling
const CUMULATIVE = SYMBOLS.reduce((acc, sym) => {
  const prev = acc.length ? acc[acc.length - 1] : 0;
  acc.push(prev + sym.weight);
  return acc;
}, []);

// ─── Paytable ────────────────────────────────────────────────────────────────

// 3-of-a-kind payouts indexed by symbol index (0–5)
const PAY_3 = [6, 15, 24, 41, 180, 650];

// 2-of-a-kind payouts for specific symbols (keyed by symbol index)
const PAY_2 = new Map([
  [4, 1],  // Diamond pair → 1× per-line bet
  [5, 4],  // Rocket pair  → 4× per-line bet
]);

// ─── Core RNG ────────────────────────────────────────────────────────────────

/**
 * Sample one symbol index (0–5) using the weighted distribution.
 * Uses crypto.randomInt for a uniform integer in [0, TOTAL_WEIGHT).
 */
function sampleSymbol() {
  const r = crypto.randomInt(0, TOTAL_WEIGHT); // 0 … 31
  for (let i = 0; i < CUMULATIVE.length; i++) {
    if (r < CUMULATIVE[i]) return i;
  }
  return SYMBOLS.length - 1; // unreachable but safe
}

/**
 * Spin one reel column: returns an array of 3 independently-sampled symbols.
 * [top, center, bottom]
 */
function spinReel() {
  return [sampleSymbol(), sampleSymbol(), sampleSymbol()];
}

// ─── Payline evaluator ───────────────────────────────────────────────────────

/**
 * Evaluate a single payline.
 * @param {[number, number, number]} line — three symbol indices
 * @returns {number} multiplier applied to the per-line bet (0 = no win)
 */
function evaluateLine(line) {
  const [a, b, c] = line;

  // 3-of-a-kind (highest priority)
  if (a === b && b === c) return PAY_3[a];

  // 2-of-a-kind — find any matching pair, return the best paying one
  const pairs = new Set();
  if (a === b) pairs.add(a);
  if (b === c) pairs.add(b);
  if (a === c) pairs.add(a);

  if (pairs.size > 0) {
    let best = 0;
    for (const s of pairs) {
      const pay = PAY_2.get(s) ?? 0;
      if (pay > best) best = pay;
    }
    if (best > 0) return best;
  }

  return 0;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Execute a full slot spin.
 *
 * @param {number} betAmount  Total wager in USD (before payline split)
 * @returns {{
 *   grid:         number[][],  // grid[reelIndex][rowIndex], 3 reels × 3 rows
 *   paylines:     PaylineResult[],
 *   totalPayout:  number,      // total return to player
 *   netResult:    number,      // totalPayout - betAmount (negative = loss)
 * }}
 *
 * @typedef {{
 *   index:      number,   // 0|1|2
 *   symbols:    number[], // [s0, s1, s2]
 *   multiplier: number,
 *   payout:     number,
 * }} PaylineResult
 */
export function spin(betAmount) {
  if (typeof betAmount !== 'number' || betAmount <= 0) {
    throw new Error('Invalid betAmount');
  }

  // Spin the 3 reels (each reel = 3-row column)
  const grid = [spinReel(), spinReel(), spinReel()];
  // grid[reelIdx][rowIdx]

  // Evaluate each of the 3 horizontal paylines
  const betPerLine = betAmount / 3;
  let totalPayout  = 0;
  const paylines   = [];

  for (let row = 0; row < 3; row++) {
    const symbols    = [grid[0][row], grid[1][row], grid[2][row]];
    const multiplier = evaluateLine(symbols);
    const payout     = parseFloat((betPerLine * multiplier).toFixed(6));
    totalPayout     += payout;
    paylines.push({ index: row, symbols, multiplier, payout });
  }

  totalPayout = parseFloat(totalPayout.toFixed(6));

  return {
    grid,
    paylines,
    totalPayout,
    netResult: parseFloat((totalPayout - betAmount).toFixed(6)),
  };
}

/**
 * Compute the theoretical RTP by exhaustive enumeration (216 combos).
 * Used for verification — call from a script, not during a game.
 */
export function computeRTP() {
  let rtp = 0;
  for (let a = 0; a < 6; a++) {
    for (let b = 0; b < 6; b++) {
      for (let c = 0; c < 6; c++) {
        const p   = (SYMBOLS[a].weight / TOTAL_WEIGHT)
                  * (SYMBOLS[b].weight / TOTAL_WEIGHT)
                  * (SYMBOLS[c].weight / TOTAL_WEIGHT);
        const pay = evaluateLine([a, b, c]);
        rtp      += p * pay;
      }
    }
  }
  return rtp;
}
