/**
 * daily-vrf-seed.js — Chainlink VRF daily seed worker
 *
 * Responsibility
 * ──────────────
 * Called once at server boot (and again at midnight by cron) to ensure the
 * game has a fresh Chainlink-sourced random seed in the `daily_seeds` table.
 *
 * Flow
 * ────
 *  1. Query `daily_seeds` — if a seed was inserted < 24 h ago, skip and return
 *     (idempotent: safe to call multiple times).
 *  2. Send a requestNewSeed() tx to the AegisVRF contract on Base Sepolia.
 *  3. Poll eth_getLogs (queryFilter) every 15 s for the SeedGenerated event.
 *     The event carries the Chainlink random number.
 *  4. Insert a row into `daily_seeds` with the random seed and a freshly
 *     generated casino_salt (a server-side secret that prevents players from
 *     pre-computing crash outcomes even though the seed is public on-chain).
 *  5. server.js picks up the new row via Supabase Realtime and hot-reloads
 *     ACTIVE_SERVER_SEED without restarting the server.
 *
 * Why queryFilter instead of a websocket filter?
 * ───────────────────────────────────────────────
 * Many JSON-RPC providers (including public Base Sepolia endpoints) do not
 * support eth_getFilterChanges (the websocket/filter API).  queryFilter uses
 * eth_getLogs which is universally supported.
 *
 * Environment variables required
 * ──────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RPC_URL                         — Base Sepolia RPC endpoint
 *   HOUSE_PRIVATE_KEY               — house wallet private key
 *   CHAINLINKVRF_CONTRACT_ADDRESS   — deployed AegisVRF address
 */

import process from 'node:process';
import crypto  from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import ContractArtifact from '../abis/AegisVRF.json' with { type: 'json' };

console.log('Daily VRF Seed Worker Initialized.');

// ── Module-level Supabase client ─────────────────────────────────────────────
// Created once per process startup and reused on every call so we don't open
// a new connection on every midnight cron tick.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase    = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

/**
 * Fetch a new daily seed from Chainlink VRF and persist it to Supabase.
 *
 * Idempotent — if a seed was inserted within the last 24 hours the function
 * returns early without sending any blockchain transactions.
 */
export async function fetchDailySeed() {
  console.log('🎲 Waking up to fetch daily Chainlink VRF seed...');

  try {
    // ── Guard: Supabase must be configured ───────────────────────────────────
    if (!supabase) {
      console.error('❌ Missing Supabase environment variables. Check your .env file.');
      return;
    }

    // ── Step 1: Check if today's seed already exists ─────────────────────────
    // Query for the newest seed and skip the Chainlink request if it's < 24h old.
    const { data: latestSeed, error: dbError } = await supabase
      .from('daily_seeds')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // PGRST116 = "No rows returned" — not a real error; it just means the table
    // is empty (first ever boot).  Any other error is worth surfacing.
    if (dbError && dbError.code !== 'PGRST116') {
      console.error('Database error checking recent seeds:', dbError);
      return;
    }

    // ── Step 2: Freshness check ───────────────────────────────────────────────
    if (latestSeed) {
      const lastSeedDate       = new Date(latestSeed.created_at);
      const hoursSinceLastSeed = (Date.now() - lastSeedDate) / (1000 * 60 * 60);

      if (hoursSinceLastSeed < 24) {
        console.log(
          `✅ Daily VRF Seed is up to date ` +
          `(last fetched ${hoursSinceLastSeed.toFixed(1)} h ago). ` +
          `Skipping Chainlink request.`,
        );
        return;
      }
    }

    console.log('🎲 24 hours have passed (or no seed exists). Requesting new seed from Chainlink...');

    // ── Step 3: Set up blockchain connection ─────────────────────────────────
    const RPC_URL                      = process.env.RPC_URL;
    const HOUSE_PRIVATE_KEY            = process.env.HOUSE_PRIVATE_KEY;
    const CHAINLINKVRF_CONTRACT_ADDRESS = process.env.CHAINLINKVRF_CONTRACT_ADDRESS;

    if (!RPC_URL || !HOUSE_PRIVATE_KEY || !CHAINLINKVRF_CONTRACT_ADDRESS) {
      console.error('❌ Missing Web3 environment variables. Check your .env file.');
      return;
    }

    const provider   = new ethers.JsonRpcProvider(RPC_URL);
    const wallet     = new ethers.Wallet(HOUSE_PRIVATE_KEY, provider);
    // Use the FULL ABI (not just the function selector) so ethers can decode
    // custom errors (e.g. UnauthorizedAccess) with a descriptive message.
    const vrfContract = new ethers.Contract(
      CHAINLINKVRF_CONTRACT_ADDRESS,
      ContractArtifact.abi,
      wallet,
    );

    // ── Step 4: Send the VRF request transaction (idempotent) ───────────────
    // Problem: when K8s restarts the pod (rolling update, crash, etc.) the new
    // pod's fetchDailySeed() runs again.  If the previous pod already submitted
    // a requestNewSeed() tx that is still pending in the mempool, submitting
    // the same nonce + calldata again gets a JSON-RPC -32000 "already known"
    // error and the worker crashes — missing the eventual Chainlink response.
    //
    // Fix (two layers):
    //   Layer 1 — Nonce check: compare latestNonce vs pendingNonce.  If they
    //     differ, a tx from this wallet is already in the mempool; skip the
    //     send and jump straight to polling.  Works when the RPC supports the
    //     'pending' block tag (most do).
    //   Layer 2 — Error catch: if the RPC returns "already known" anyway
    //     (e.g. the provider collapses pending/latest), treat it as a
    //     successful send and jump to polling.  Never re-throw this error.
    //
    // In either bypass case we start polling from currentBlock - 50 (~10 min
    // of Base Sepolia blocks) so we don't miss an oracle response that arrived
    // while the pod was being replaced.

    console.log('📡 Sending requestNewSeed() to Base Sepolia...');
    let fromBlock;

    try {
      const latestNonce  = await wallet.getNonce('latest');
      const pendingNonce = await wallet.getNonce('pending');

      if (pendingNonce > latestNonce) {
        // A tx from this wallet is already sitting in the mempool.
        // This is normal after a pod restart — don't submit another.
        console.log(
          `⚠️  VRF request already pending in mempool (latest nonce: ${latestNonce}, ` +
          `pending: ${pendingNonce}). Skipping re-submit — awaiting Chainlink response...`,
        );
        fromBlock = Math.max(0, (await provider.getBlockNumber()) - 50);
      } else {
        // No pending tx — safe to send a fresh VRF request.
        const tx = await vrfContract.requestNewSeed({ nonce: latestNonce });
        console.log(`⏳ Transaction sent! Hash: ${tx.hash}`);
        const receipt = await tx.wait(); // wait for 1 confirmation before polling
        console.log('✅ Transaction confirmed. Waiting for Chainlink Oracle response...');
        fromBlock = receipt.blockNumber;
      }

    } catch (txErr) {
      // Layer 2 fallback: RPC returned "already known" (-32000).
      // This means an identical tx (same nonce + data) is already in the
      // mempool.  It is NOT a fatal error — the oracle will still respond.
      const msg = String(
        txErr?.info?.error?.message ?? txErr?.error?.message ?? txErr?.message ?? '',
      ).toLowerCase();
      const isAlreadyKnown = msg.includes('already known') || txErr?.error?.code === -32000;

      if (isAlreadyKnown) {
        console.log(
          `⚠️  eth_sendRawTransaction returned "already known" — ` +
          `previous pod already submitted this VRF request. ` +
          `Skipping re-submit — awaiting Chainlink response...`,
        );
        fromBlock = Math.max(0, (await provider.getBlockNumber()) - 50);
      } else {
        throw txErr; // genuine unexpected error — let the outer catch log it
      }
    }

    // ── Step 5: Poll for the SeedGenerated event ──────────────────────────────
    // We poll eth_getLogs every 15 s for up to 10 minutes.  Chainlink VRF on
    // Base Sepolia typically responds within 1–3 blocks (~2–6 seconds).
    //
    // queryFilter() is used instead of filter listeners because most public
    // RPC providers do not support eth_getFilterChanges (WebSocket filter API).
    const deadline  = Date.now() + 10 * 60 * 1000; // 10-minute timeout

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 15_000)); // wait 15 s between polls

      const events = await vrfContract.queryFilter(
        vrfContract.filters.SeedGenerated(), // filter: only SeedGenerated events
        fromBlock,                            // from: the block our request landed in
      );

      if (events.length > 0) {
        // Chainlink delivered the randomness — extract from event args
        const { args } = events[0];
        const requestId  = args[0]; // uint256 VRF request ID
        const randomSeed = args[1]; // uint256 random value from Chainlink

        console.log(`🔥 SUCCESS! Chainlink delivered seed for Request ID: ${requestId.toString()}`);

        // Generate a casino salt: a server-side secret that is combined with
        // the public Chainlink seed when computing crash points.  This means
        // players cannot pre-compute tomorrow's crash outcomes even though the
        // Chainlink seed is visible on-chain.
        const casinoSalt = crypto.randomBytes(32).toString('hex');

        const { error } = await supabase
          .from('daily_seeds')
          .insert({
            vrf_request_id: requestId.toString(),
            chainlink_seed:  randomSeed.toString(),
            casino_salt:     casinoSalt,
          });

        if (error) {
          console.error('❌ Failed to save to Supabase:', error);
        } else {
          console.log('💾 Daily Seed and Secret Salt locked into Supabase. Ready for the day!');
        }
        return; // success — exit the polling loop
      }
    }

    // If we reach here the Oracle never responded within 10 minutes.
    // The server will keep using the previous day's seed until the next boot
    // or midnight cron triggers another attempt.
    console.error('❌ Timed out waiting for Chainlink Oracle response after 10 minutes.');

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // If the full ABI is loaded, ethers will decode custom contract errors
    // (e.g. 'UnauthorizedAccess') instead of showing a generic hex revert.
    console.error('❌ Worker failed:', errorMessage);
  }
}
