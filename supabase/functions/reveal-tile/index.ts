import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// UPDATED: Import the Total Payout function instead!
import { calculateTotalPayout } from '../_shared/betting-logic.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    const { gameId, tileId } = await req.json();
    
    // 1. Fetch Game State
    const { data: game, error: fetchError } = await supabase
      .from("mines_games")
      .select("*")
      .eq("id", gameId)
      .single();

    if (fetchError || !game || game.status !== 'active') {
      throw new Error("Game not found or already finished.");
    }

    // 2. Prevent Double-Clicking
    if (game.revealed_tiles.includes(tileId)) {
      throw new Error("Tile already revealed.");
    }

    const isMine = game.mine_positions.includes(tileId);
    let updateData: Record<string, unknown> = {}; 
    let newMultiplier = game.payout_multiplier;

    if (isMine) {
      updateData = {
        status: 'busted',
        revealed_tiles: [...game.revealed_tiles, tileId],
        final_payout: 0,
      };
    } else {
      // FIX: Calculate the true accumulated multiplier using $1 as a base
      newMultiplier = calculateTotalPayout(1, game.revealed_tiles.length + 1, {
        totalTiles: 25,
        mineCount: game.mine_count,
        houseEdge: 0.02, // 🚨 UPDATED: 2% House Edge (98% RTP)
      });

      updateData = {
        revealed_tiles: [...game.revealed_tiles, tileId],
        payout_multiplier: newMultiplier,
      };
    }

    // 3. Update Database
    const { error: updateError } = await supabase
      .from("mines_games")
      .update(updateData)
      .eq("id", gameId);

    if (updateError) throw updateError;

    // FIX: Restored minePositions to the return statement so the board reveals!
    return new Response(JSON.stringify({ 
      isMine, 
      payout_multiplier: newMultiplier,
      minePositions: game.mine_positions 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err: unknown) {
    let errorMessage = "Unknown error";
    if (err instanceof Error) errorMessage = err.message;
    else if (typeof err === 'object' && err !== null && 'message' in err) {
      errorMessage = String((err as Record<string, unknown>).message);
    }
    return new Response(JSON.stringify({ error: errorMessage }), { 
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
