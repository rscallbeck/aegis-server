import process from 'node:process';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import ContractArtifact from '../abis/AegisVRF.json' with { type: "json" };

console.log("Daily VRF Seed Worker Initialized.");

// ── Module-level Supabase client — created once, reused on every daily call ──
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export async function fetchDailySeed() {
  console.log("🎲 Waking up to fetch daily Chainlink VRF seed...");

  try {
    if (!supabase) {
      console.error("❌ Missing Supabase environment variables. Check your .env file.");
      return;
    }

    // 1. Query the database for the single most recently created seed
    const { data: latestSeed, error: dbError } = await supabase
      .from('daily_seeds')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // Ignore PGRST116 (No rows found)
    if (dbError && dbError.code !== 'PGRST116') {
      console.error("Database error checking recent seeds:", dbError);
      return;
    }

    // 2. Calculate the time difference if a seed exists
    if (latestSeed) {
      const lastSeedDate = new Date(latestSeed.created_at);
      const now = new Date();
      
      const hoursSinceLastSeed = (now - lastSeedDate) / (1000 * 60 * 60);

      if (hoursSinceLastSeed < 24) {
        console.log(`✅ Daily VRF Seed is up to date (Last fetched ${hoursSinceLastSeed.toFixed(1)} hours ago). Skipping Chainlink request.`);
        return;
      }
    }

    console.log('🎲 24 hours have passed (or no seed exists). Waking up to fetch daily Chainlink VRF seed...');

    // 3. Setup Blockchain Connection
    const RPC_URL = process.env.RPC_URL;
    const HOUSE_PRIVATE_KEY = process.env.HOUSE_PRIVATE_KEY;
    const CHAINLINKVRF_CONTRACT_ADDRESS = process.env.CHAINLINKVRF_CONTRACT_ADDRESS;

    if (!RPC_URL || !HOUSE_PRIVATE_KEY || !CHAINLINKVRF_CONTRACT_ADDRESS) {
      console.error("❌ Missing Web3 environment variables. Check your .env file.");
      return; 
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(HOUSE_PRIVATE_KEY, provider);

    // Initialize the contract USING THE FULL ABI to catch custom errors
    const vrfContract = new ethers.Contract(CHAINLINKVRF_CONTRACT_ADDRESS, ContractArtifact.abi, wallet);

    // 4. Request the seed from the smart contract
    console.log("📡 Sending request to Base Sepolia...");

    const currentNonce = await wallet.getNonce("pending");
    const tx = await vrfContract.requestNewSeed({ nonce: currentNonce });

    console.log(`⏳ Transaction sent! Hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log("✅ Transaction confirmed. Waiting for Chainlink Oracle response...");

    // 5. Poll for SeedGenerated using queryFilter (eth_getLogs) instead of
    //    filter-based listeners — many RPC providers don't support eth_getFilterChanges.
    const fromBlock = receipt.blockNumber;
    const deadline = Date.now() + 10 * 60 * 1000;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 15000));
      const events = await vrfContract.queryFilter(
        vrfContract.filters.SeedGenerated(),
        fromBlock
      );
      if (events.length > 0) {
        const { args } = events[0];
        const requestId = args[0];
        const randomSeed = args[1];

        console.log(`🔥 SUCCESS! Chainlink delivered seed for Request ID: ${requestId.toString()}`);

        const casinoSalt = crypto.randomBytes(32).toString('hex');

        const { error } = await supabase
          .from('daily_seeds')
          .insert({
            vrf_request_id: requestId.toString(),
            chainlink_seed: randomSeed.toString(),
            casino_salt: casinoSalt
          });

        if (error) {
          console.error("❌ Failed to save to Supabase:", error);
        } else {
          console.log("💾 Daily Seed and Secret Salt locked into Supabase. You are ready for the day!");
        }
        return;
      }
    }

    console.error("❌ Timed out waiting for Chainlink Oracle response after 10 minutes.");

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("❌ Worker failed:", errorMessage);
    
    // Because we are using the full ABI now, if this fails due to a custom error, 
    // it will log the actual error name (e.g., 'UnauthorizedAccess') here!
  }
}
