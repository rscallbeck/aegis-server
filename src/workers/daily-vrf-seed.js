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

    // ── Step 4: Send the VRF request transaction ──────────────────────────────
    // Explicitly fetch the pending nonce to avoid collisions with other
    // in-flight transactions from the house wallet.
    console.log('📡 Sending requestNewSeed() to Base Sepolia...');
    const currentNonce = await wallet.getNonce('pending');
    const tx           = await vrfContract.requestNewSeed({ nonce: currentNonce });

    console.log(`⏳ Transaction sent! Hash: ${tx.hash}`);
    const receipt = await tx.wait(); // wait for 1 confirmation before polling
    console.log('✅ Transaction confirmed. Waiting for Chainlink Oracle response...');

    // ── Step 5: Poll for the SeedGenerated event ──────────────────────────────
    // We poll eth_getLogs every 15 s for up to 10 minutes.  Chainlink VRF on
    // Base Sepolia typically responds within 1–3 blocks (~2–6 seconds).
    //
    // queryFilter() is used instead of filter listeners because most public
    // RPC providers do not support eth_getFilterChanges (WebSocket filter API).
    const fromBlock = receipt.blockNumber; // start scanning from the request block
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
