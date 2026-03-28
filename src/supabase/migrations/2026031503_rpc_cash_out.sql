CREATE OR REPLACE FUNCTION handle_cash_out(
  p_game_id UUID,
  p_user_id UUID,
  p_payout DECIMAL(18, 8)
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER -- Runs with elevated privileges to bypass RLS for the atomic update
AS $$
DECLARE
  v_current_status TEXT;
BEGIN
  -- 1. Lock the row to prevent race conditions (double cash-outs)
  SELECT status INTO v_current_status 
  FROM mines_games 
  WHERE id = p_game_id AND user_id = p_user_id 
  FOR UPDATE;

  -- 2. Validate state
  IF v_current_status != 'active' THEN
    RAISE EXCEPTION 'Game is not active or has already been processed.';
  END IF;

  -- 3. Update the Game State
  UPDATE mines_games
  SET 
    status = 'cashed_out', 
    final_payout = p_payout
  WHERE id = p_game_id;

  -- 4. Update the User's Balance
  UPDATE profiles
  SET balance_usd = balance_usd + p_payout
  WHERE id = p_user_id;

  RETURN TRUE;
END;
$$;
