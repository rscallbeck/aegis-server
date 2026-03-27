import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !user) throw new Error('Unauthorized');

    const { amount } = await req.json();
    if (!amount || amount <= 0) throw new Error('Invalid deposit amount');

    // 🚨 FIX 1: Use maybeSingle() so it doesn't crash if you don't have a profile yet!
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('balance_usd')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) throw profileError;

    // Calculate current balance (defaulting to 0 if the profile is missing)
    const currentBalance = profile ? Number(profile.balance_usd) : 0;
    const newBalance = currentBalance + Number(amount);

    // 🚨 FIX 2: Use upsert() to automatically create the row if it's missing!
    const { error: updateError } = await supabase
      .from('profiles')
      .upsert({ id: user.id, balance_usd: newBalance });

    if (updateError) throw updateError;

    return new Response(JSON.stringify({ success: true, newBalance }), {
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
