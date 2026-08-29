-- Ejecutar en Supabase > SQL Editor.
-- La clave anon nunca debe tener permisos para crear tablas.

create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"series":[],"folders":[],"allTags":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

drop policy if exists "Users can read their own data" on public.user_data;
create policy "Users can read their own data"
  on public.user_data for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own data" on public.user_data;
create policy "Users can insert their own data"
  on public.user_data for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own data" on public.user_data;
create policy "Users can update their own data"
  on public.user_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Opcional: perfil básico para futuras preferencias de usuario.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select using (auth.uid() = id);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create table if not exists public.public_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('list', 'folder')),
  entity_id text not null,
  share_token text not null unique,
  snapshot jsonb not null,
  is_public boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (owner_id, entity_type, entity_id)
);

alter table public.public_shares enable row level security;

drop policy if exists "Anyone can read public shares" on public.public_shares;
create policy "Anyone can read public shares"
  on public.public_shares for select
  using (is_public = true or auth.uid() = owner_id);

drop policy if exists "Users can create their own shares" on public.public_shares;
create policy "Users can create their own shares"
  on public.public_shares for insert
  with check (auth.uid() = owner_id);

drop policy if exists "Users can update their own shares" on public.public_shares;
create policy "Users can update their own shares"
  on public.public_shares for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "Users can delete their own shares" on public.public_shares;
create policy "Users can delete their own shares"
  on public.public_shares for delete
  using (auth.uid() = owner_id);
