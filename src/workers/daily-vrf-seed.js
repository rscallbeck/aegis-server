import process from 'node:process';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

console.log("Daily VRF Seed Worker Initialized.");

export async function fetchDailySeed() {
  console.log("🎲 Waking up to fetch daily Chainlink VRF seed...");

  try {

    // Initialize Supabase Service Role client (Requires the master key to check global tables)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabase = createClient(supabaseUrl, supabaseKey);

    if (!supabaseUrl || !supabaseKey ) {
      console.error("❌ Missing required environment variables. Check your .env file.");
      return; 
    }

    // 1. Query the database for the single most recently created seed
    const { data: latestSeed, error: dbError } = await supabase
      .from('aegis_project_schema.daily_seeds')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // Ignore PGRST116, which just means "No rows found" (e.g., the very first time the server boots)
    if (dbError && dbError.code !== 'PGRST116') {
      console.error("Database error checking recent seeds:", dbError);
      return;
    }

    // 2. Calculate the time difference if a seed exists
    if (latestSeed) {
      const lastSeedDate = new Date(latestSeed.created_at);
      const now = new Date();
      
      // Convert millisecond difference into hours
      const hoursSinceLastSeed = (now - lastSeedDate) / (1000 * 60 * 60);

      if (hoursSinceLastSeed < 24) {
        console.log(`✅ Daily VRF Seed is up to date (Last fetched ${hoursSinceLastSeed.toFixed(1)} hours ago). Skipping Chainlink request.`);
        return;
      }
    }

    console.log('🎲 24 hours have passed (or no seed exists). Waking up to fetch daily Chainlink VRF seed...');

    const RPC_URL = process.env.RPC_URL;
    const HOUSE_PRIVATE_KEY = process.env.HOUSE_WALLET_PRIVATE_KEY;
    const CONTRACT_ADDRESS = process.env.CHAINLINKVRF_CONTRACT_ADDRESS;

    if (!RPC_URL || !HOUSE_PRIVATE_KEY || !CONTRACT_ADDRESS) {
      console.error("❌ Missing required environment variables. Check your .env file.");
      return; 
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(HOUSE_PRIVATE_KEY, provider);

    // Minimal ABI needed to request the seed and listen for the event
    const contractABI = [
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
    vrfContract.once("SeedGenerated", async (requestId, randomSeed) => {
      console.log(`🔥 SUCCESS! Chainlink delivered seed for Request ID: ${requestId.toString()}`);
      
      const casinoSalt = crypto.randomBytes(32).toString('hex');
      
      const { error } = await supabase
        .from('aegis_project_schema.daily_seeds')
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
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("❌ Worker failed:", errorMessage);
  }
}
