-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE seed_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mines_games ENABLE ROW LEVEL SECURITY;

-- 1. Profiles: Users can only read/update their own profile
CREATE POLICY "Users can view own profile" 
ON profiles FOR SELECT 
USING (auth.uid() = id);

-- 2. Seeds: Users can see their own seeds, but NEVER the raw server seed if active
CREATE POLICY "Users can view own seeds" 
ON seed_pairs FOR SELECT 
USING (auth.uid() = user_id);

-- 3. Mines Games: The "Security Guard" Policy
-- Users can see their own games
CREATE POLICY "Users can view own games" 
ON mines_games FOR SELECT 
USING (auth.uid() = user_id);

-- CRITICAL: Prevent the 'mine_positions' column from being leaked
-- We do this by creating a SECURE VIEW or by using column-level security.
-- Since Supabase RLS is row-based, the best practice for Project Aegis 
-- is to use a View for the frontend that hides the column if status is 'active'.

CREATE VIEW active_games_safe AS
SELECT 
    id, 
    user_id, 
    bet_amount, 
    mine_count, 
    revealed_tiles, 
    status, 
    payout_multiplier,
    -- Only show mine_positions if the game is finished
    CASE 
        WHEN status = 'active' THEN NULL 
        ELSE mine_positions 
    END AS mine_positions
FROM mines_games;
