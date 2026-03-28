-- 1. PROFILES & WALLETS
CREATE TABLE profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  wallet_address TEXT UNIQUE,
  username TEXT UNIQUE,
  balance_usd DECIMAL(18, 8) DEFAULT 0.00,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. SEED SYSTEM (The Fairness Engine)
-- We store the hash of the server seed. The raw seed is only revealed 
-- when the user rotates to a new seed pair.
CREATE TABLE seed_pairs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id),
  server_seed_hash TEXT NOT NULL,
  server_seed_raw TEXT, -- NULL until the seed is rotated/expired
  client_seed TEXT NOT NULL,
  nonce INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. MINES GAMES
CREATE TABLE mines_games (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id),
  seed_pair_id UUID REFERENCES seed_pairs(id),
  bet_amount DECIMAL(18, 8) NOT NULL,
  mine_count INTEGER NOT NULL,
  
  -- The "Hidden" State
  mine_positions INTEGER[] NOT NULL, -- e.g., [4, 12, 18]
  revealed_tiles INTEGER[] DEFAULT '{}', -- Tiles the user has clicked
  
  status TEXT CHECK (status IN ('active', 'cashed_out', 'busted')) DEFAULT 'active',
  payout_multiplier DECIMAL(12, 4) DEFAULT 1.0000,
  final_payout DECIMAL(18, 8) DEFAULT 0.00,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);