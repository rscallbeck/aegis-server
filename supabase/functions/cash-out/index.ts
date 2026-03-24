import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // 1. Verify User Session
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !user) throw new Error('Unauthorized');

    const { gameId } = await req.json();

    // 2. Fetch Active Game State
    const { data: game, error: fetchError } = await supabase
      .from("mines_games")
      .select("*")
      .eq("id", gameId)
      .eq("user_id", user.id) // Ensure they own the game
      .single();

    if (fetchError || !game) throw new Error("Game not found.");
    if (game.status !== 'active') throw new Error("Game is not active (already busted or cashed out).");
    if (game.revealed_tiles.length === 0) throw new Error("You must reveal at least one tile to cash out!");

    // 3. Calculate Winnings
    const finalPayout = game.bet_amount * game.payout_multiplier;

    // 4. Mark Game as Cashed Out
    const { error: updateError } = await supabase
      .from("mines_games")
      .update({
        status: 'cashed_out',
        final_payout: finalPayout,
      })
      .eq("id", gameId)
      .eq("status", "active"); // Concurrency safety check

    if (updateError) throw updateError;

    // 5. Deposit Winnings to Profile Balance
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('balance_usd')
      .eq('id', user.id)
      .single();

    if (profileError) throw profileError;

    const newBalance = Number(profile.balance_usd) + finalPayout;

    await supabase.from('profiles').update({ balance_usd: newBalance }).eq('id', user.id);

    // ✅ CORRECT SUCCESS RETURN: Includes the new minePositions data
    return new Response(JSON.stringify({ 
      success: true, 
      finalPayout, 
      newBalance,
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
    
    // ✅ CORRECT ERROR RETURN: Uses the errorMessage variable properly
    return new Response(JSON.stringify({ error: errorMessage }), { 
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
