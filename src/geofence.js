/**
 * Geofence module for Aegis
 *
 * Blocks connections from countries where Aegis is not licensed to operate.
 * Uses ip-api.com for IP → country resolution (free tier, server-side only).
 *
 * Configuration (server .env):
 *   GEO_ALLOWED_IPS  — comma-separated IPs that bypass geofencing (e.g. your own IP)
 *   GEO_FAIL_OPEN    — set to "false" to block users when IP lookup fails (default: allow)
 */

// ─── Countries where Aegis is not licensed to operate ──────────────────────
// Standard list for an unlicensed crypto casino.  Add/remove ISO-3166-1 alpha-2
// codes as your licensing situation changes.
export const BLOCKED_COUNTRIES = new Set([
  // OFAC-sanctioned jurisdictions (mandatory for any online operator)
  'KP', // North Korea
  'IR', // Iran
  'CU', // Cuba
  'SY', // Syria
  'RU', // Russia
  'BY', // Belarus
  'MM', // Myanmar

  // Major regulated gambling markets that require a local licence
  'US', // United States — UIGEA / federal wire fraud risk
  'GB', // United Kingdom — UKGC requires UK licence
  'FR', // France — ANJ (formerly ARJEL)
  'NL', // Netherlands — Kansspelautoriteit (KSA)
  'AU', // Australia — Interactive Gambling Act
  'BE', // Belgium — CBG/JOC
  'DE', // Germany — GlüStV 2021
  'IT', // Italy — ADM
  'ES', // Spain — DGOJ
  'SE', // Sweden — Spelinspektionen
  'DK', // Denmark — Spillemyndigheden
  'NO', // Norway — Lotteritilsynet
  'PL', // Poland — strict online gambling ban
  'CZ', // Czechia
  'RO', // Romania
  'BG', // Bulgaria
  'PT', // Portugal
  'LT', // Lithuania
  'HU', // Hungary
  'SK', // Slovakia
  'SG', // Singapore — Remote Gambling Act
  'CN', // China
]);

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Return the set of explicitly allowed IPs from the GEO_ALLOWED_IPS env var. */
function getAllowedIps() {
  const raw = process.env.GEO_ALLOWED_IPS ?? '';
  return new Set(raw.split(',').map((ip) => ip.trim()).filter(Boolean));
}

/**
 * Return true for loopback and RFC-1918 private addresses.
 * These always bypass geofencing (local dev, internal k8s traffic).
 */
function isPrivateIp(ip) {
  if (!ip) return true;
  // Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4)
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return (
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === 'localhost' ||
    /^10\./.test(clean) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(clean) ||
    /^192\.168\./.test(clean)
  );
}

/**
 * Extract the real client IP from an Express req or Socket.IO handshake object.
 * Respects X-Forwarded-For set by nginx / k8s ingress.
 */
export function extractIp(reqOrHandshake) {
  const headers =
    reqOrHandshake?.headers ??
    reqOrHandshake?.handshake?.headers ??
    {};

  const forwarded = headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For can be a comma-separated list; leftmost is the client
    return forwarded.split(',')[0].trim();
  }

  return (
    reqOrHandshake?.socket?.remoteAddress ?? // Express req
    reqOrHandshake?.ip ??                    // Express req (set by trust proxy)
    reqOrHandshake?.address ??               // Socket.IO socket.handshake.address
    reqOrHandshake?.handshake?.address ??    // Socket.IO socket.handshake (when socket passed directly)
    ''
  );
}

/**
 * Resolve an IP address to a two-letter ISO country code.
 * Uses ip-api.com free tier (45 req/min, HTTP only — called server-side only).
 * Returns null values on failure.
 */
async function resolveCountry(ip) {
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status === 'success') {
      return { countryCode: data.countryCode, country: data.country };
    }
  } catch (err) {
    console.warn(`[Geofence] Country lookup failed for ${ip}: ${err.message}`);
  }
  return { countryCode: null, country: null };
}

// ─── Main check ────────────────────────────────────────────────────────────

/**
 * Determine whether a request should be allowed through.
 * Accepts either an Express `req` object or a Socket.IO `socket.handshake`.
 *
 * Returns:
 *   { allowed: boolean, ip: string, countryCode: string|null, country: string|null, reason: string }
 *
 * Reasons:
 *   'private'         — loopback / RFC-1918 address (always allowed)
 *   'allowlisted'     — IP is in GEO_ALLOWED_IPS (always allowed)
 *   'allowed'         — country not in blocked list
 *   'blocked_country' — country is in blocked list
 *   'lookup_failed'   — could not resolve country (allowed by default; see GEO_FAIL_OPEN)
 */
export async function checkAllowed(reqOrHandshake) {
  const ip = extractIp(reqOrHandshake);

  // 1. Always allow private / local IPs
  if (isPrivateIp(ip)) {
    return { allowed: true, ip, countryCode: null, country: null, reason: 'private' };
  }

  // 2. Check explicit IP allowlist (env: GEO_ALLOWED_IPS)
  if (getAllowedIps().has(ip)) {
    return { allowed: true, ip, countryCode: null, country: null, reason: 'allowlisted' };
  }

  // 3. Resolve country via ip-api.com
  const { countryCode, country } = await resolveCountry(ip);

  if (!countryCode) {
    // Lookup failed — fail open by default (set GEO_FAIL_OPEN=false to flip)
    const failOpen = process.env.GEO_FAIL_OPEN !== 'false';
    return {
      allowed: failOpen,
      ip,
      countryCode: null,
      country: null,
      reason: 'lookup_failed',
    };
  }

  if (BLOCKED_COUNTRIES.has(countryCode)) {
    return { allowed: false, ip, countryCode, country, reason: 'blocked_country' };
  }

  return { allowed: true, ip, countryCode, country, reason: 'allowed' };
}
