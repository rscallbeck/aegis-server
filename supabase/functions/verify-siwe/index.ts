import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyMessage } from "https://esm.sh/viem@2.21.19";

// Standard CORS headers  

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
    const { message, signature, address } = await req.json();

    // 1. Verify the signature
    const isValid = await verifyMessage ({
      address: address as `0x${string}`,
      message,
      signature,
    });

    if (!isValid) throw new Error("Invalid signature");

    const email = `${address.toLowerCase()}@web3.aegis`;
    
    // 2. Create a secure, deterministic password based on a server secret
    const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.substring(0, 16) || "fallback";
    const dummyPassword = `${address}_${secret}`;

    // 3. Ensure the user exists in Supabase Auth (fails silently if they already exist)
    await supabase.auth.admin.createUser({
      email: email,
      password: dummyPassword,
      email_confirm: true,
    });

    // 4. Return the credentials to the frontend so it can securely sign in!
    return new Response(JSON.stringify({ 
      success: true, 
      email: email,
      password: dummyPassword 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: errorMessage }), { 
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
