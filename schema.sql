-- ============================================================
-- Life Control Center — schema
-- Cole TUDO isto no Supabase > SQL Editor > New query > Run
-- ============================================================

-- Tabela unica de armazenamento (chave/valor) por usuario.
-- Guarda: itens ('lcc_items_v1'), ajustes ('lcc_settings_v1')
-- e anexos ('lcc_att_*').
create table if not exists public.kv (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null,
  value      text,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Row Level Security: cada pessoa so enxerga as proprias linhas.
alter table public.kv enable row level security;

drop policy if exists "kv_select_own" on public.kv;
drop policy if exists "kv_insert_own" on public.kv;
drop policy if exists "kv_update_own" on public.kv;
drop policy if exists "kv_delete_own" on public.kv;

create policy "kv_select_own" on public.kv
  for select using (auth.uid() = user_id);

create policy "kv_insert_own" on public.kv
  for insert with check (auth.uid() = user_id);

create policy "kv_update_own" on public.kv
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "kv_delete_own" on public.kv
  for delete using (auth.uid() = user_id);

-- Indice para listar chaves por prefixo (ex.: anexos).
create index if not exists kv_user_key_idx on public.kv (user_id, key);
