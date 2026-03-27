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

    // Parse the body to see if the user provided a custom client seed
    const { customClientSeed } = await req.json().catch(() => ({ customClientSeed: null }));

    // 2. Find currently active seed
    const { data: oldSeed } = await supabase
      .from('seed_pairs')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single();

    if (oldSeed) {
      // Deactivate it!
      await supabase.from('seed_pairs').update({ is_active: false }).eq('id', oldSeed.id);
    }

    // 3. Generate New Seed Pair
    const serverSeedRaw = crypto.randomUUID();
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serverSeedRaw));
    const serverSeedHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    
    // Use the player's custom seed, or generate a random one for them
    const clientSeed = customClientSeed || ("client_" + Math.random().toString(36).substring(2, 10));

    const { data: newSeed, error: insertError } = await supabase
      .from('seed_pairs')
      .insert({
        user_id: user.id,
        server_seed_raw: serverSeedRaw,
        server_seed_hash: serverSeedHash,
        client_seed: clientSeed,
        nonce: 0,
        is_active: true
      })
      .select('*')
      .single();

    if (insertError) throw insertError;

    return new Response(JSON.stringify({ 
      success: true, 
      oldServerSeedRaw: oldSeed ? oldSeed.server_seed_raw : null,
      newClientSeed: clientSeed,
      newServerSeedHash: serverSeedHash
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
