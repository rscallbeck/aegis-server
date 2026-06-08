/**
 * Aegis Edge Worker
 *
 * Runs at Cloudflare's edge in front of all aegisgaming.net hostnames.
 * Handles:
 *   1. Geofencing  — block jurisdictions where Aegis is not licensed
 *   2. CORS         — preflight handling for cross-origin Socket.IO
 *   3. Pass-through — all other traffic forwarded to the Cloudflare tunnel
 *                     via fetch(request); Cloudflare routes to the correct
 *                     origin based on hostname (no explicit proxy URL needed).
 *
 * Env vars (set via wrangler vars / dashboard):
 *   CORS_ORIGINS — comma-separated allowed origins, e.g. https://www.aegisgaming.net
 */

// ── Blocked jurisdictions ──────────────────────────────────────────────────
// ISO 3166-1 alpha-2 country codes.
// Blocked = countries where Aegis licence does not apply or online gambling
// is prohibited. Update as licence coverage expands.
const BLOCKED_COUNTRIES = new Set([
  // Licensed-jurisdiction blocks
  // 'US',  // uncomment when US is not yet licensed
  'GB', 'AU', 'FR', 'NL', 'SG', 'CN', 'HK', 'IN',
  // FATF blacklist
  'KP', 'IR', 'MM',
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') ?? '';

    // ── 1. Geofencing ──────────────────────────────────────────────────────
    const country = (request as any).cf?.country ?? null;

    if (country && BLOCKED_COUNTRIES.has(country)) {
      return new Response(
        JSON.stringify({
          error: 'Service unavailable in your region.',
          code: 'GEO_BLOCKED',
          country,
        }),
        {
          status: 451, // 451 Unavailable For Legal Reasons
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        }
      );
    }

    // ── 2. CORS preflight ──────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse(origin, env);
    }

    // ── 3. Pass-through to tunnel origin ───────────────────────────────────
    // fetch(request) lets Cloudflare route to the correct tunnel origin for
    // this hostname. The Worker is not re-invoked for the subrequest.
    const response = await fetch(request);
    return addCorsHeaders(new Response(response.body, response), origin, env);
  },
} satisfies ExportedHandler<Env>;

// ── Helpers ────────────────────────────────────────────────────────────────

function getAllowedOrigins(env: Env): string[] {
  return ((env as any).CORS_ORIGINS ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
}

function isOriginAllowed(origin: string, env: Env): boolean {
  const allowed = getAllowedOrigins(env);
  return allowed.includes('*') || allowed.includes(origin);
}

function addCorsHeaders(response: Response, origin: string, env: Env): Response {
  if (!isOriginAllowed(origin, env)) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin || '*');
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

function corsPreflightResponse(origin: string, env: Env): Response {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
  });
  if (isOriginAllowed(origin, env)) {
    headers.set('Access-Control-Allow-Origin', origin || '*');
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(null, { status: 204, headers });
}
