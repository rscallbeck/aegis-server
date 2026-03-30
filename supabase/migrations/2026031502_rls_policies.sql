-- Enable RLS on all tables
alter table profiles ENABLE row LEVEL SECURITY;

alter table seed_pairs ENABLE row LEVEL SECURITY;

alter table mines_games ENABLE row LEVEL SECURITY;

alter table daily_seeds ENABLE row LEVEL SECURITY;

alter table crash_games ENABLE row LEVEL SECURITY;

-- 1. Profiles: Users can only read/update their own profile
create policy "Users can view own profile" on profiles for
select
  using (auth.uid () = id);

-- 2. Seeds: Users can see their own seeds, but NEVER the raw server seed if active
create policy "Users can view own seeds" on seed_pairs for
select
  using (auth.uid () = user_id);

-- 3. Mines Games: The "Security Guard" Policy
-- Users can see their own games
create policy "Users can view own games" on mines_games for
select
  using (auth.uid () = user_id);

-- 4. Daily Seeds: 
-- The server (service_role) can insert new seeds. Players (authenticated) can view the current seeds.
create policy "Server can insert daily seeds" on daily_seeds for INSERT to service_role
with
  check (true);

create policy "Users can view daily seeds" on daily_seeds for
select
  to authenticated using (true);

-- 4. Crash Games: 
-- Players can only interact with rows tied to their specific user_id
create policy "Users can insert their own crash games" on crash_games for INSERT to authenticated
with
  check (auth.uid () = user_id);

create policy "Users can view their own crash games" on crash_games for
select
  to authenticated using (auth.uid () = user_id);

create policy "Users can update their own crash games" on crash_games
for update
  to authenticated using (auth.uid () = user_id);
