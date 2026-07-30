-- ============================================================
-- Life Control — conexões externas (Oura, Google)
-- Cole no Supabase > SQL Editor > New query > Run
-- ============================================================

-- Tokens das contas conectadas.
-- ATENÇÃO: RLS ligado e SEM políticas de leitura para o usuário.
-- Isso faz com que os tokens só possam ser lidos pelo servidor
-- (service_role). Nem o seu próprio navegador consegue vê-los.
create table if not exists public.connections (
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider      text not null,                 -- 'oura' | 'google'
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  scope         text,
  account_email text,
  updated_at    timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.connections enable row level security;
-- (nenhuma policy = ninguém acessa pelo navegador; só o servidor)

-- Estados temporários do fluxo OAuth (protege contra CSRF).
create table if not exists public.oauth_states (
  state      text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  provider   text not null,
  created_at timestamptz not null default now()
);

alter table public.oauth_states enable row level security;

-- Limpeza de estados velhos (mais de 1 hora).
create index if not exists oauth_states_created_idx on public.oauth_states (created_at);
