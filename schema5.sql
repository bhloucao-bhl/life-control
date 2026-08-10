-- ============================================================
-- Life Control — tokens de push notification (Firebase Cloud Messaging)
-- Cole no Supabase > SQL Editor > New query > Run
-- ============================================================

-- Um token por device. platform fica fixo em 'ios' por enquanto (sem Android
-- ainda). O mesmo device pode reinstalar/reautenticar e gerar um token novo
-- do Firebase — por isso token é unique e o upsert troca o dono se um device
-- for reaproveitado por outro usuário.
create table if not exists public.push_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  token      text not null unique,
  platform   text not null default 'ios',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_tokens_user_id_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;
-- (nenhuma policy = só o servidor com service_role acessa, como em "connections")
