import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import process from 'node:process';
import path from 'node:path';
import cron from 'node-cron';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { fetchDailySeed } from './src/workers/daily-vrf-seed.js';
import { initVault, settleRound } from './src/vault.js';
import { checkAllowed } from './src/geofence.js';
import { spin as slotsSpin, SYMBOLS as SLOTS_SYMBOLS } from './src/games/slots.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, './.env') });

const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN;
const TICK_RATE_MS = 50;
const ROUND_START_TIME_SEC = 10;
const ROUND_COOLDOWN_MS = 5000;
const MAX_CHAT_HISTORY = 50;
const HOUSE_EDGE_RTP = 50; // 1-in-50 instant crash → 98% RTP contribution

// ─── Game limits ────────────────────────────────────────────────────────────
const MAX_BET_AMOUNT = 10_000;        // Maximum single bet in USD
const MAX_TARGET_MULTIPLIER = 1_000;  // Maximum auto-cashout multiplier

// ─── Per-socket rate limiting ────────────────────────────────────────────────
// Simple token-bucket: each socket gets RATE_LIMIT_CAPACITY tokens, replenished
// at RATE_LIMIT_REFILL_MS.  Each event costs one token.  Prevents spam without
// blocking legitimate fast players.
const RATE_LIMIT_CAPACITY   = 10;      // max burst
const RATE_LIMIT_REFILL_MS  = 1_000;  // refill one token per second

const socketRateLimits = new Map(); // socketId → { tokens, lastRefill }

function consumeRateLimit(socketId) {
  const now = Date.now();
  let bucket = socketRateLimits.get(socketId);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_CAPACITY, lastRefill: now };
    socketRateLimits.set(socketId, bucket);
  }
  // Refill based on time elapsed
  const elapsed = now - bucket.lastRefill;
  const refill   = Math.floor(elapsed / RATE_LIMIT_REFILL_MS);
  if (refill > 0) {
    bucket.tokens    = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + refill);
    bucket.lastRefill = now;
  }
  if (bucket.tokens <= 0) return false; // rate-limited
  bucket.tokens--;
  return true;
}

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.static(path.join(__dirname, 'public/client')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ─── Geofence check endpoint ───────────────────────────────────────────────
// The static client calls this on load to decide whether to show the block screen.
// Returns: { allowed, countryCode, country, reason }
app.get('/api/geo-check', async (req, res) => {
  try {
    const result = await checkAllowed(req);
    res.json({
      allowed:     result.allowed,
      countryCode: result.countryCode ?? null,
      country:     result.country     ?? null,
      reason:      result.reason,
    });
  } catch (err) {
    console.error('[Geofence] /api/geo-check error:', err.message);
    // Fail open — don't block users when the check itself errors
    res.json({ allowed: true, countryCode: null, country: null, reason: 'error' });
  }
});

// ─── SSL: read paths from env vars, fall back to the old hardcoded location ───
// FIX #3: was hardcoded, which broke Docker/K8s deployments.
// Set CERT_KEY_PATH and CERT_CRT_PATH in your .env (or K8s secret) to override.
const KEY_PATH  = process.env.CERT_KEY_PATH  || path.join(__dirname, 'certificates/key.pem');
const CERT_PATH = process.env.CERT_CRT_PATH  || path.join(__dirname, 'certificates/cert.pem');

let server;
if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
  const options = {
    key:  fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
  };
  server = https.createServer(options, app);
  console.log('🔒 HTTPS mode (certs found)');
} else {
  // During local dev without certs, fall back to plain HTTP so the server
  // actually starts rather than crashing.  NEVER do this in production.
  server = http.createServer(app);
  console.warn('⚠️  No SSL certs found — running in HTTP mode (dev only). '
    + 'Set CERT_KEY_PATH and CERT_CRT_PATH for production.');
}

const io = new Server(server, {
  // ── CORS ────────────────────────────────────────────────────────────────
  // CORS_ORIGIN must be set in .env / K8s secret.  Guard against undefined
  // so the option is always a valid string rather than silently being
  // `{ origin: undefined }`, which causes Socket.IO to omit the header
  // entirely and lets some browsers block the WebSocket upgrade.
  cors: {
    origin:  CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST'],
  },

  // ── Heartbeat tuning ─────────────────────────────────────────────────────
  // Default pingInterval (25 s) + pingTimeout (20 s) = 45 s total before a
  // stalled connection is declared dead.  Raising pingTimeout to 30 s gives
  // K8s kube-proxy and any intermediate NAT gateway enough breathing room to
  // survive a brief packet loss without dropping the socket.
  //
  // These values are intentionally conservative — a genuine dead connection
  // is detected no later than 25 + 30 = 55 s, which is still fast enough
  // that a crashed server pod is noticed within one round of Crash.
  pingInterval: 25_000, // ms between server → client PING frames
  pingTimeout:  30_000, // ms the server waits for a PONG before disconnecting
});

// ─── Supabase ──────────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Check your .env file.');
  // FIX #4: was process.exit(0) — exit code 0 means "success" and K8s won't restart the pod.
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  global: { transport: WebSocket },
});

// ─── Provably Fair seed (loaded from Chainlink VRF via daily worker) ────────
let ACTIVE_SERVER_SEED = null;
let ACTIVE_SALT = null;
let ACTIVE_VRF_REQUEST_ID = null;

async function loadLatestSeed() {
  const { data, error } = await supabase
    .from('daily_seeds')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    console.warn('⚠️  No seed found in DB — using a temporary local seed. '
      + 'Run your VRF worker to get a Chainlink seed.');
    ACTIVE_SERVER_SEED = crypto.randomBytes(32).toString('hex');
    ACTIVE_SALT = 'TEMPORARY_LOCAL_SALT';
  } else {
    ACTIVE_SERVER_SEED = data.chainlink_seed;
    ACTIVE_SALT        = data.casino_salt;
    ACTIVE_VRF_REQUEST_ID = data.vrf_request_id;
    console.log(`🔐 Loaded Provably Fair Seed (VRF Req: ${ACTIVE_VRF_REQUEST_ID})`);
  }
}

// Hot-reload seed whenever a new Chainlink seed is inserted into the DB
supabase
  .channel('seed-updates')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'daily_seeds' }, (payload) => {
    console.log('\n🔄 NEW CHAINLINK SEED DETECTED — updating game math for the next round...');
    ACTIVE_SERVER_SEED    = payload.new.chainlink_seed;
    ACTIVE_SALT           = payload.new.casino_salt;
    ACTIVE_VRF_REQUEST_ID = payload.new.vrf_request_id;
  })
  .subscribe();

// Refresh seed at midnight every day
cron.schedule('0 0 * * *', () => {
  console.log('Midnight: fetching new Chainlink VRF seed...');
  fetchDailySeed();
});

// Fetch a seed immediately on boot so the first round has one
console.log('Fetching initial VRF seed on boot...');
fetchDailySeed();

// ─── AegisVault (on-chain settlement) ──────────────────────────────────────
initVault();

// ─── Game state ────────────────────────────────────────────────────────────
let currentRoundId = 1;
const gameState = {
  status: 'starting',
  multiplier: 1.00,
  crashPoint: 0,
  timeRemaining: ROUND_START_TIME_SEC,
  roundId: currentRoundId,
  activeBets: {},
  history: [],
};

const chatHistory = [];

// ─── Provably fair crash-point generator ──────────────────────────────────
// Formula: HMAC-SHA256(serverSeed, salt:roundId) → deterministic crash point.
// Players can verify every round after the server seed is revealed.
function generateCrashPoint(serverSeed, salt, roundId) {
  if (!serverSeed || !salt) return 1.00; // safe fallback before seed loads

  const hash = crypto.createHmac('sha256', serverSeed)
    .update(`${salt}:${roundId}`)
    .digest('hex');

  const h = parseInt(hash.substring(0, 13), 16);
  const e = Math.pow(2, 52);

  // 1-in-HOUSE_EDGE_RTP chance of an instant crash at 1.00x (house always wins that round)
  if (h % HOUSE_EDGE_RTP === 0) return 1.00;

  const crashPoint = Math.floor((100 * e - h) / (e - h)) / 100.0;
  return Math.min(Math.max(1.00, crashPoint), 1_000_000);
}

// ─── Atomic balance helpers ─────────────────────────────────────────────────
// NOTE: These call Supabase RPC functions (Postgres stored procedures) so the
// read-modify-write is a single atomic operation — no TOCTOU race condition.
//
// You need to create these two functions in your Supabase SQL editor:
//
//   -- Run this once in Supabase → SQL Editor
//   CREATE OR REPLACE FUNCTION deduct_balance(p_user_id UUID, p_amount NUMERIC)
//   RETURNS NUMERIC LANGUAGE plpgsql AS $$
//   DECLARE result NUMERIC;
//   BEGIN
//     UPDATE profiles
//       SET balance_usd = balance_usd - p_amount
//       WHERE id = p_user_id AND balance_usd >= p_amount
//       RETURNING balance_usd INTO result;
//     IF result IS NULL THEN
//       RAISE EXCEPTION 'Insufficient balance';
//     END IF;
//     RETURN result;
//   END; $$;
//
//   CREATE OR REPLACE FUNCTION credit_balance(p_user_id UUID, p_amount NUMERIC)
//   RETURNS NUMERIC LANGUAGE plpgsql AS $$
//   DECLARE result NUMERIC;
//   BEGIN
//     UPDATE profiles
//       SET balance_usd = balance_usd + p_amount
//       WHERE id = p_user_id
//       RETURNING balance_usd INTO result;
//     RETURN result;
//   END; $$;

async function deductBalance(userId, amount) {
  const { data, error } = await supabase.rpc('deduct_balance', {
    p_user_id: userId,
    p_amount: amount,
  });
  if (error) throw new Error(error.message); // will contain 'Insufficient balance' if that's the case
  return data; // returns the new balance
}

async function creditBalance(userId, amount) {
  const { data, error } = await supabase.rpc('credit_balance', {
    p_user_id: userId,
    p_amount: amount,
  });
  if (error) throw new Error(error.message);
  return data;
}

// ─── Game loop ─────────────────────────────────────────────────────────────
async function runGameLoop() {
  await loadLatestSeed();

  while (true) {
    // ── Betting phase ──────────────────────────────────────────────────────
    gameState.status      = 'starting';
    gameState.multiplier  = 1.00;
    gameState.activeBets  = {};
    gameState.timeRemaining = ROUND_START_TIME_SEC;
    gameState.roundId     = currentRoundId;
    // Pre-compute crash point NOW so we can reveal the hash to players before launch
    gameState.crashPoint  = generateCrashPoint(ACTIVE_SERVER_SEED, ACTIVE_SALT, currentRoundId);

    console.log(`\n🟢 ROUND [${currentRoundId}]: Accepting bets...`);

    while (gameState.timeRemaining > 0) {
      io.emit('game-tick', gameState);
      await new Promise(r => setTimeout(r, 1000));
      gameState.timeRemaining--;
    }

    // ── Flight phase ───────────────────────────────────────────────────────
    gameState.status = 'in-progress';
    console.log(`🚀 LAUNCHED! (Secret crash point: ${gameState.crashPoint}x)`);

    while (gameState.multiplier < gameState.crashPoint) {
      gameState.multiplier += gameState.multiplier * 0.005;
      if (gameState.multiplier > gameState.crashPoint) {
        gameState.multiplier = gameState.crashPoint;
      }

      // Check for auto-cashouts (players who set a target multiplier)
      for (const [userId, bet] of Object.entries(gameState.activeBets)) {
        if (!bet.cashedOut && gameState.multiplier >= bet.targetMultiplier) {
          bet.cashedOut = true;
          bet.winnings  = parseFloat((bet.betAmount * bet.targetMultiplier).toFixed(6));

          // FIX #1: was fire-and-forget .then() — if Supabase failed, player
          // received 'bet-won' but their balance never increased. Now we await
          // inside an IIFE so errors are caught and logged without stalling the loop.
          (async () => {
            try {
              await creditBalance(userId, bet.winnings);

              // Persist cashout immediately (crash_point filled in at round end)
              if (bet.dbId) {
                supabase
                  .from('crash_bets')
                  .update({
                    status:        'cashed_out',
                    cashed_out_at: bet.targetMultiplier,
                    final_payout:  bet.winnings,
                  })
                  .eq('id', bet.dbId)
                  .then(({ error }) => {
                    if (error) console.warn('⚠️  crash_bets auto-cashout update failed:', error.message);
                  });
              }

              io.to(bet.socketId).emit('bet-won', {
                multiplier: bet.targetMultiplier,
                winnings: bet.winnings,
              });
            } catch (err) {
              console.error(`❌ Auto-cashout credit failed for user ${userId}:`, err.message);
              // Emit a specific error so the client can show a message
              io.to(bet.socketId).emit('bet-error', 'Auto-cashout failed — contact support.');
            }
          })();
        }
      }

      io.emit('game-tick', gameState);
      await new Promise(r => setTimeout(r, TICK_RATE_MS));
    }

    // ── Crash ──────────────────────────────────────────────────────────────
    gameState.status = 'crashed';
    gameState.history.push(parseFloat(gameState.multiplier.toFixed(2)));
    if (gameState.history.length > 10) gameState.history.shift();

    const roundHash = crypto.createHmac('sha256', ACTIVE_SERVER_SEED)
      .update(`${ACTIVE_SALT}:${currentRoundId}`)
      .digest('hex');

    console.log(`💥 CRASHED at ${gameState.multiplier.toFixed(2)}x | Provable hash: ${roundHash}`);

    io.emit('game-tick', gameState);

    // ── Persist crash outcome for all bets in this round ───────────────────
    // Auto-cashouts were already updated when they fired; we only need to
    // finalize the bets that are still 'active' (i.e., player didn't cash out).
    (async () => {
      const crashMultiplier = parseFloat(gameState.multiplier.toFixed(2));
      for (const bet of Object.values(gameState.activeBets)) {
        if (!bet.dbId) continue;
        if (bet.cashedOut) {
          // Auto-cashout: crash_point is now known — fill it in
          supabase
            .from('crash_bets')
            .update({ crash_point: crashMultiplier })
            .eq('id', bet.dbId)
            .then(({ error }) => {
              if (error) console.warn('⚠️  crash_bets crash_point update failed:', error.message);
            });
        } else {
          // Player did not cash out — mark as crashed with zero payout
          supabase
            .from('crash_bets')
            .update({ status: 'crashed', crash_point: crashMultiplier, final_payout: 0 })
            .eq('id', bet.dbId)
            .then(({ error }) => {
              if (error) console.warn('⚠️  crash_bets crashed update failed:', error.message);
            });
        }
      }
    })();

    // ── On-chain settlement (fire-and-forget) ────────────────────────────────
    // Call AegisVault.settleBet() for every bet this round.  We do this after
    // emitting to clients so the crash is never delayed by RPC latency.
    // If a player hasn't deposited to the vault yet the call will be skipped
    // gracefully — Supabase balance_usd remains the operative ledger until
    // the deposit/withdraw flow is live.
    // settleRound() is a no-op when the vault is not initialised, so no guard needed.
    const betsToSettle = Object.values(gameState.activeBets)
      .filter(bet => bet.walletAddress)
      .map(bet => ({
        playerAddress: bet.walletAddress,
        betAmountEth:  bet.betAmount.toString(),
        playerWon:     bet.cashedOut,
        payoutEth:     bet.cashedOut ? bet.winnings.toString() : '0',
      }));

    if (betsToSettle.length > 0) {
      console.log(`🏦 Settling ${betsToSettle.length} bet(s) on-chain for round ${currentRoundId}...`);
      settleRound(betsToSettle).catch(err =>
        console.error('❌ Vault settlement error:', err.message),
      );
    }

    currentRoundId++;
    await new Promise(r => setTimeout(r, ROUND_COOLDOWN_MS));
  }
}

// ─── Socket event handlers ─────────────────────────────────────────────────

// In-memory set to prevent concurrent bet placement for the same user.
// NOTE: This only protects a single-process deployment. For multi-instance,
// use the deduct_balance RPC (which is atomic at the DB level) as the true guard.
const pendingBetUsers = new Set();

async function handlePlaceBet(socket, { token, betAmount, targetMultiplier }) {
  if (gameState.status !== 'starting') {
    return socket.emit('bet-error', 'Round already in progress!');
  }

  try {
    // Input validation
    if (typeof betAmount !== 'number' || betAmount <= 0) {
      throw new Error('Invalid bet amount');
    }
    if (betAmount > MAX_BET_AMOUNT) {
      throw new Error(`Bet amount cannot exceed $${MAX_BET_AMOUNT}`);
    }
    if (typeof targetMultiplier !== 'number' || targetMultiplier <= 1.0) {
      throw new Error('Target multiplier must be greater than 1.0');
    }
    if (targetMultiplier > MAX_TARGET_MULTIPLIER) {
      throw new Error(`Target multiplier cannot exceed ${MAX_TARGET_MULTIPLIER}x`);
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) throw new Error('Unauthorized');

    // Prevent double-betting in the same round
    if (gameState.activeBets[user.id]) {
      throw new Error('You have already placed a bet this round');
    }

    // Prevent concurrent placement for the same user (app-level lock)
    if (pendingBetUsers.has(user.id)) {
      throw new Error('Your previous bet is still being processed');
    }
    pendingBetUsers.add(user.id);

    try {
      // FIX #2: was a non-atomic read-then-write (TOCTOU).
      // deductBalance() is a single atomic Postgres UPDATE … WHERE balance >= amount,
      // so two simultaneous requests cannot both succeed if the balance is only enough for one.
      await deductBalance(user.id, betAmount);
    } finally {
      pendingBetUsers.delete(user.id);
    }

    // Resolve wallet address from the user's Supabase email.
    // verify-siwe encodes it as "{address}@web3.aegis", so we just parse the prefix.
    let walletAddress = null;
    try {
      const { data: { user: authUser } } = await supabase.auth.admin.getUserById(user.id);
      if (authUser?.email?.endsWith('@web3.aegis')) {
        walletAddress = authUser.email.split('@')[0];
      }
    } catch (err) {
      console.warn(`⚠️  Could not resolve wallet address for user ${user.id}:`, err.message);
    }

    // Persist the bet so the History page can show it
    const { data: betRow, error: betInsertError } = await supabase
      .from('crash_bets')
      .insert({
        user_id:           user.id,
        round_id:          currentRoundId,
        bet_amount:        betAmount,
        target_multiplier: targetMultiplier,
        status:            'active',
      })
      .select('id')
      .single();

    if (betInsertError) {
      console.warn(`⚠️  Could not persist crash bet for user ${user.id}:`, betInsertError.message);
    }

    gameState.activeBets[user.id] = {
      socketId: socket.id,
      walletAddress,      // stored for vault settlement at round end
      betAmount,
      targetMultiplier,
      cashedOut: false,
      winnings: 0,
      dbId: betRow?.id ?? null,   // for updating the record on cashout / crash
    };

    socket.emit('bet-accepted', { betAmount, targetMultiplier });

  } catch (err) {
    // Note: pendingBetUsers only holds user.id values, which are only added AFTER
    // auth succeeds. If we reach here due to an auth failure, nothing was added and
    // there is nothing to clean up. The inner try/finally handles the success-then-
    // deductBalance-fails case. No delete needed here.
    socket.emit('bet-error', err.message);
  }
}

async function handleCashOut(socket, { token }) {
  if (gameState.status !== 'in-progress') {
    return socket.emit('bet-error', 'No active round to cash out from!');
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) throw new Error('Unauthorized');

    const bet = gameState.activeBets[user.id];
    if (!bet) throw new Error('No active bet found for this round');
    if (bet.cashedOut) throw new Error('Already cashed out');

    // Capture multiplier synchronously before any await to prevent double-payout races
    const cashOutMultiplier = gameState.multiplier;
    bet.cashedOut = true;
    bet.winnings  = parseFloat((bet.betAmount * cashOutMultiplier).toFixed(6));

    // Credit the winnings atomically
    await creditBalance(user.id, bet.winnings);

    // Update the bet record in the DB
    if (bet.dbId) {
      supabase
        .from('crash_bets')
        .update({
          status:        'cashed_out',
          cashed_out_at: cashOutMultiplier,
          final_payout:  bet.winnings,
        })
        .eq('id', bet.dbId)
        .then(({ error }) => {
          if (error) console.warn(`⚠️  crash_bets update (cashout) failed:`, error.message);
        });
    }

    // Send back the multiplier and amount so the client can display them
    socket.emit('bet-won', {
      multiplier: cashOutMultiplier,
      winnings: bet.winnings,
    });

  } catch (err) {
    socket.emit('bet-error', err.message);
  }
}

// ─── Slots handler ────────────────────────────────────────────────────────────
// Balances are mocked for now (UI-first sprint).  Real deduct/credit calls
// will be added when Slots is wired up to Supabase in a later sprint.

async function handleSlotsSpin(socket, { token, betAmount }) {
  try {
    // Input validation
    if (typeof betAmount !== 'number' || betAmount <= 0) {
      throw new Error('Invalid bet amount');
    }
    if (betAmount > MAX_BET_AMOUNT) {
      throw new Error(`Bet amount cannot exceed $${MAX_BET_AMOUNT}`);
    }

    // Auth check (validates the JWT; balance deduction skipped until sprint N)
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) throw new Error('Unauthorized');

    // Execute the spin (pure RNG — no state mutated server-side for slots)
    const result = slotsSpin(betAmount);

    // Persist to Supabase (non-blocking — don't await so latency doesn't affect client)
    const winningLines = result.paylines.filter(p => p.payout > 0).length;
    supabase.from('slots_bets').insert({
      user_id:      user.id,
      bet_amount:   betAmount,
      total_payout: result.totalPayout,
      net_result:   result.netResult,
      multiplier:   result.totalPayout > 0 ? result.totalPayout / betAmount : null,
      paylines_hit: winningLines,
      status:       result.totalPayout > 0 ? 'won' : 'lost',
    }).then(({ error: dbErr }) => {
      if (dbErr) console.error('[slots] DB insert failed:', dbErr.message);
    });

    socket.emit('slots-result', {
      grid:        result.grid,       // number[3][3] — grid[reelIdx][rowIdx]
      paylines:    result.paylines,   // [{ index, symbols, multiplier, payout }]
      totalPayout: result.totalPayout,
      netResult:   result.netResult,
      betAmount,
    });

  } catch (err) {
    socket.emit('slots-error', err.message);
  }
}

// ─── Slots symbols manifest endpoint ─────────────────────────────────────────
// The client fetches this once on mount so it can render symbol names/emoji
// without duplicating the definition.
app.get('/api/slots/symbols', (_req, res) => {
  res.json(SLOTS_SYMBOLS);
});

async function handleSendMessage(socket, { token, message }) {
  try {
    if (typeof message !== 'string' || message.trim() === '') return;
    const cleanMessage = message.trim().substring(0, 150);

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) throw new Error('Unauthorized');

    const username = 'P' + user.id.substring(0, 4).toUpperCase();
    const chatMsg  = {
      id: crypto.randomUUID(),
      username,
      message: cleanMessage,
      time: new Date().toISOString(),
    };

    chatHistory.push(chatMsg);
    if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();

    io.emit('new-message', chatMsg);
  } catch {
    socket.emit('chat-error', 'Sign in to chat!');
  }
}

// ─── Socket.IO geofencing middleware ──────────────────────────────────────
// Runs before every connection is accepted.  Blocked connections are refused
// before any game state is sent to the client.
io.use(async (socket, next) => {
  try {
    const result = await checkAllowed(socket.handshake);
    if (!result.allowed) {
      console.log(
        `🚫 [Geofence] Blocked Socket.IO connection from ${result.ip}` +
        (result.country ? ` (${result.country})` : ''),
      );
      return next(new Error('GEO_BLOCKED'));
    }
    next();
  } catch (err) {
    console.error('[Geofence] Socket middleware error:', err.message);
    next(); // fail open
  }
});

// ─── Socket connections ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('game-tick', gameState);
  socket.emit('chat-history', chatHistory);

  const rateGuard = (eventName, handler) => (data) => {
    if (!consumeRateLimit(socket.id)) {
      socket.emit('bet-error', 'Too many requests — please slow down.');
      console.warn(`[RateLimit] socket=${socket.id} throttled on "${eventName}"`);
      return;
    }
    handler(data);
  };

  socket.on('place-bet',    rateGuard('place-bet',    (data) => handlePlaceBet(socket, data)));
  socket.on('cash-out',     rateGuard('cash-out',     (data) => handleCashOut(socket, data)));
  socket.on('send-message', rateGuard('send-message', (data) => handleSendMessage(socket, data)));
  socket.on('spin-slots',   rateGuard('spin-slots',   (data) => handleSlotsSpin(socket, data)));

  socket.on('disconnect', () => {
    socketRateLimits.delete(socket.id);
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const protocol = server instanceof https.Server ? 'HTTPS' : 'HTTP';
  console.log(`✅ Aegis Crash Engine running on ${protocol} port ${PORT}`);
  runGameLoop();
});

