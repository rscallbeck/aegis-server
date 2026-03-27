import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createHmac } from "https://deno.land/std@0.168.0/node/crypto.ts";

interface MinesRequest {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  mineCount: number; // e.g., 1 to 24
}

interface MinesResponse {
  hash: string;
  minePositions: number[];
}

/**
 * Generates a provably fair board using Fisher-Yates shuffle
 * driven by the HMAC-SHA256 of the combined seeds.
 */
function generateProvablyFairBoard(
  serverSeed: string, 
  clientSeed: string, 
  nonce: number, 
  mineCount: number
): number[] {
  const boardSize = 25;
  const board = Array.from({ length: boardSize }, (_, i) => i);
  
  // Combine seeds: "server:client:nonce"
  const combinedSeed = `${serverSeed}:${clientSeed}:${nonce}`;
  
  // Use HMAC to create a deterministic random stream
  const hmac = createHmac("sha256", combinedSeed);
  const hash = hmac.digest("hex");
  
  // Convert hex segments into numbers to drive the shuffle
  // In a production environment, you'd use a more robust "byte-to-float" generator
  // to ensure no bias, but this demonstrates the deterministic flow:
  let seedCursor = 0;
  for (let i = board.length - 1; i > 0; i--) {
    const hexSegment = hash.substring(seedCursor, seedCursor + 2);
    const j = parseInt(hexSegment, 16) % (i + 1);
    [board[i], board[j]] = [board[j], board[i]];
    seedCursor = (seedCursor + 2) % (hash.length - 2);
  }

  // The first 'mineCount' elements are our mine positions
  return board.slice(0, mineCount).sort((a, b) => a - b);
}

serve(async (req) => {
  try {
    const { serverSeed, clientSeed, nonce, mineCount }: MinesRequest = await req.json();

    // 1. Generate the board
    const minePositions = generateProvablyFairBoard(serverSeed, clientSeed, nonce, mineCount);

    // 2. Return the positions
    // NOTE: In a live game, the server only returns "Hit/Miss" for a specific tile 
    // until the game is over to prevent client-side cheating.
    return new Response(
      JSON.stringify({ minePositions }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400 });
  }
});
