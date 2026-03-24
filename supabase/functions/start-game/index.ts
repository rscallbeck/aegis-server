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

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !user) throw new Error('Unauthorized');

    const { betAmount, mineCount } = await req.json();

    // 1. Dev Faucet & Balance Check
    const { data: profile } = await supabase
      .from('profiles')
      .select('balance_usd')
      .eq('id', user.id)
      .single();

    let currentBalance = profile?.balance_usd || 0;

    if (currentBalance < betAmount) {
      // Auto-fund empty developer accounts with $1,000 to test!
      currentBalance = 1000; 
    }

    const newBalance = currentBalance - betAmount;
    await supabase.from('profiles').upsert({ id: user.id, balance_usd: newBalance });

// 2. Auto-Generate Provably Fair Seeds if missing
    let { data: seedPair } = await supabase
      .from('seed_pairs') // Matches SQL
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single();

    if (!seedPair) {
      const serverSeedRaw = crypto.randomUUID();
      const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serverSeedRaw));
      const serverSeedHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
      const clientSeed = "client_" + Math.random().toString(36).substring(2, 10);

      const { data: newSeed, error: seedError } = await supabase
        .from('seed_pairs')
        .insert({
          user_id: user.id,
          server_seed_raw: serverSeedRaw, // Matches SQL
          server_seed_hash: serverSeedHash,
          client_seed: clientSeed,
          nonce: 0,
          is_active: true
        })
        .select('*')
        .single();

      if (seedError) throw seedError;
      seedPair = newSeed;
    }

    const newNonce = seedPair.nonce + 1;
    await supabase.from('seed_pairs').update({ nonce: newNonce }).eq('id', seedPair.id);

    // 3. Generate Mines via Fisher-Yates
    const seedString = `${seedPair.server_seed_raw}:${seedPair.client_seed}:${newNonce}`;
    const hashBufferMines = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seedString));
    const hashArray = Array.from(new Uint8Array(hashBufferMines));

    const deck = Array.from({ length: 25 }, (_, i) => i);
    let cursor = 0;
    
    for (let i = 24; i > 0; i--) {
      const randomInt = (hashArray[cursor] << 8) | hashArray[cursor + 1];
      cursor = (cursor + 2) % (hashArray.length - 1);
      const j = randomInt % (i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    
    const minePositions = deck.slice(0, mineCount);

    // 4. Create the Game Record
    const { data: game, error: insertError } = await supabase
      .from('mines_games')
      .insert({
        user_id: user.id,
        seed_pair_id: seedPair.id, // Matches SQL
        bet_amount: betAmount,
        mine_count: mineCount,     // Matches SQL
        mine_positions: minePositions, 
        status: 'active'
      })
      .select('id')
      .single();

    if (insertError) throw insertError;

    return new Response(JSON.stringify({ success: true, gameId: game.id, newBalance }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
    
} catch (err: unknown) {
    console.error("Game start error:", err);
    
    // Extract the real error message even if it's a Supabase custom error object
    let errorMessage = "Unknown error";
    if (typeof err === 'object' && err !== null) {
      if ('message' in err) {
        errorMessage = String((err as Record<string, unknown>).message);
      } else {
        errorMessage = JSON.stringify(err);
      }
    } else if (typeof err === 'string') {
      errorMessage = err;
    }

    return new Response(JSON.stringify({ error: errorMessage }), { 
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
