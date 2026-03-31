-- ==========================================
-- 1. PROFILES & WALLETS
-- ========================================== 
create table profiles (
  id UUID references auth.users on delete CASCADE primary key,
  wallet_address TEXT unique,
  username TEXT unique,
  balance_usd DECIMAL(18, 8) default 0.00,
  created_at TIMESTAMPTZ default NOW()
);

-- ==========================================
-- 2. SEED SYSTEM (The Fairness Engine)
-- We store the hash of the server seed. The raw seed is only revealed 
-- when the user rotates to a new seed pair.
-- ========================================== 
create table seed_pairs (
  id UUID default gen_random_uuid () primary key,
  user_id UUID references profiles (id),
  server_seed_hash TEXT not null,
  server_seed_raw TEXT, -- NULL until the seed is rotated/expired
  client_seed TEXT not null,
  nonce INTEGER default 0,
  is_active BOOLEAN default true,
  created_at TIMESTAMPTZ default NOW()
);

-- ==========================================
-- 3. MINES GAMES
-- ========================================== 
create table mines_games (
  id UUID default gen_random_uuid () primary key,
  user_id UUID references profiles (id),
  seed_pair_id UUID references seed_pairs (id),
  bet_amount DECIMAL(18, 8) not null,
  mine_count INTEGER not null,
  -- The "Hidden" State
  mine_positions integer[] not null, -- e.g., [4, 12, 18]
  revealed_tiles integer[] default '{}', -- Tiles the user has clicked
  status TEXT check (status in ('active', 'cashed_out', 'busted')) default 'active',
  payout_multiplier DECIMAL(12, 4) default 1.0000,
  final_payout DECIMAL(18, 8) default 0.00,
  created_at TIMESTAMPTZ default NOW()
);

-- ==========================================
-- 4. Daily Seeds Table
-- ==========================================
create table daily_seeds (
  id uuid default gen_random_uuid () primary key,
  created_at timestamptz default now() not null,
  vrf_request_id text not null,
  chainlink_seed text not null,
  casino_salt text not null
);

-- ==========================================
-- 5. Crash Games Table
-- ==========================================
create table crash_games (
  id uuid default gen_random_uuid () primary key,
  created_at timestamptz default now() not null,
  user_id uuid references profiles (id) not null,
  bet_amount numeric not null,
  cash_out_multiplier numeric,
  busted boolean default false,
  profit numeric
);

-- ==========================================
-- 6. Crash Active Games Safe View
-- ==========================================
-- The 'security_invoker = on' flag ensures this view automatically respects the RLS policies of the crash_games table!
create or replace view crash_active_games_safe
with
  (security_invoker = on) as
select
  id,
  created_at,
  user_id,
  bet_amount
from
  crash_games
where
  busted = false
  and profit is null;

-- ==========================================
-- 7. Mines Active Games Safe View
-- ==========================================
-- The 'security_invoker = on' flag ensures this view automatically respects the RLS policies of the crash_games table!
-- CRITICAL: Prevent the 'mine_positions' column from being leaked
-- We do this by creating a SECURE VIEW or by using column-level security.
-- Since Supabase RLS is row-based, the best practice for Project Aegis 
-- is to use a View for the frontend that hides the column if status is 'active'.
create view mines_active_games_safe as
select
  id,
  user_id,
  bet_amount,
  mine_count,
  revealed_tiles,
  status,
  payout_multiplier,
  -- Only show mine_positions if the game is finished
  case
    when status = 'active' then null
    else mine_positions
  end as mine_positions
from
  mines_games;
