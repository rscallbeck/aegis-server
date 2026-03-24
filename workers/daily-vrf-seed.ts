import { ethers } from 'ethers';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Reconstruct __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🚨 CHANGED: Explicitly tell dotenv to look two folders up for the master .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

console.log("Daily VRF Seed Worker Initialized.");

export async function fetchDailySeed(): Promise<void> {
  console.log("🎲 Waking up to fetch daily Chainlink VRF seed...");

  // 1. Strict Environment Variable Checks (Moved inside so it waits for server.js to load .env)
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RPC_URL = process.env.RPC_URL;
  const HOUSE_WALLET_PRIVATE_KEY = process.env.HOUSE_WALLET_PRIVATE_KEY;
  const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RPC_URL || !HOUSE_WALLET_PRIVATE_KEY || !CONTRACT_ADDRESS) {
    console.error("❌ Missing required environment variables. Check your .env file.");
    return; // 🚨 CHANGED: Use return instead of process.exit() so the server stays alive!
  }

  try {
    // 2. Setup Supabase
    const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 3. Setup Ethers & Blockchain Connection
    const provider = new ethers.JsonRpcProvider(RPC_URL); 
    const wallet = new ethers.Wallet(HOUSE_WALLET_PRIVATE_KEY, provider);

    const contractABI: string[] = [
      "function requestNewSeed() external returns (uint256)",
      "event SeedGenerated(uint256 indexed requestId, uint256 randomSeed)"
    ];

    const vrfContract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, wallet);

    // Request the seed from the smart contract
    console.log("📡 Sending request to Base Sepolia...");
    const tx = await vrfContract.requestNewSeed();
    console.log(`⏳ Transaction sent! Hash: ${tx.hash}`);
    
    await tx.wait();
    console.log("✅ Transaction confirmed. Waiting for Chainlink Oracle response...");

    // Listen for the oracle to call back with the random number
    vrfContract.once("SeedGenerated", async (requestId: bigint, randomSeed: bigint) => {
      console.log(`🔥 SUCCESS! Chainlink delivered seed for Request ID: ${requestId.toString()}`);
      
      const casinoSalt: string = crypto.randomBytes(32).toString('hex');
      
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
      // 🚨 REMOVED process.exit(0) here so the crash loop continues running!
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("❌ Worker failed:", errorMessage);
    // 🚨 REMOVED process.exit(1)
  }
}

// 🚨 REMOVED the trailing fetchDailySeed() call so it doesn't run automatically on import
