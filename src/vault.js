// ─── AegisVault — on-chain settlement module ─────────────────────────────────
//
// Wraps the deployed AegisVault contract.  Called once at the end of every
// crash round to record each bet outcome on-chain.  All calls are
// fire-and-forget: the game loop never waits for tx confirmations.
//
// NOTE: The game currently denominates bets in USD numbers (e.g. betAmount=10
// means $10).  For testnet we pass those numbers straight to parseEther() and
// treat them as ETH units.  Before mainnet, swap this for a Chainlink ETH/USD
// price feed so vault amounts reflect real value.

import { ethers } from 'ethers';
import AegisVaultArtifact from './abis/AegisVault.json' with { type: 'json' };

let vault   = null;
let signer  = null;

// ── Initialise ───────────────────────────────────────────────────────────────
// Call once at server startup.  Returns true if the vault is ready.
export function initVault() {
  const rpcUrl          = process.env.RPC_URL;
  const privateKey      = process.env.HOUSE_PRIVATE_KEY;
  const contractAddress = process.env.AEGIS_VAULT_ADDRESS;

  if (!rpcUrl || !privateKey || !contractAddress) {
    console.warn(
      '⚠️  AegisVault not initialised — set RPC_URL, HOUSE_PRIVATE_KEY, and ' +
      'AEGIS_VAULT_ADDRESS to enable on-chain settlement.',
    );
    return false;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  signer = new ethers.Wallet(privateKey, provider);
  vault  = new ethers.Contract(contractAddress, AegisVaultArtifact.abi, signer);

  console.log(`🏦 AegisVault initialised at ${contractAddress}`);
  return true;
}

export function isVaultReady() {
  return vault !== null;
}

// ── settleRound ───────────────────────────────────────────────────────────────
//
// Settle every bet from a completed round in one nonce-sequential burst.
// Submit all transactions without waiting for confirmations so the game loop
// is never stalled.
//
// @param {Array<{
//   playerAddress : string,   // checksummed 0x wallet address
//   betAmountEth  : string,   // bet size as a decimal string, e.g. "10"
//   playerWon     : boolean,
//   payoutEth     : string,   // total payout as decimal string ("0" if lost)
// }>} bets
export async function settleRound(bets) {
  if (!vault || bets.length === 0) return;

  // Fetch the pending nonce once so rapid-fire txs get sequential slots and
  // don't collide even if the RPC doesn't track pending nonces well.
  let nonce;
  try {
    nonce = await signer.getNonce('pending');
  } catch (err) {
    console.error('❌ Vault: failed to fetch nonce:', err.message);
    return;
  }

  for (const bet of bets) {
    try {
      const betWei    = ethers.parseEther(bet.betAmountEth);
      const payoutWei = ethers.parseEther(bet.payoutEth);

      const tx = await vault.settleBet(
        bet.playerAddress,
        betWei,
        bet.playerWon,
        payoutWei,
        { nonce },
      );

      // Only increment after a successful broadcast — if ethers throws before
      // sending (e.g. simulation revert), the nonce slot was never consumed.
      nonce++;
      console.log(
        `🔗 settleBet submitted | player=${bet.playerAddress} ` +
        `won=${bet.playerWon} payout=${bet.payoutEth}ETH | tx=${tx.hash}`,
      );
    } catch (err) {
      // Most common cause: player has not yet deposited to the vault.
      // Supabase balance_usd is the operative ledger until deposits are live.
      console.warn(
        `⚠️  settleBet skipped for ${bet.playerAddress}: ` +
        (err.shortMessage ?? err.message),
      );
      // Do NOT increment nonce — if ethers rejected pre-broadcast the slot
      // was not consumed on-chain.
    }
  }
}
