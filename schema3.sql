-- ============================================================
-- Life Control — sync automático do Oura via webhook
-- Cole no Supabase > SQL Editor > New query > Run
-- ============================================================

-- Id do usuário no lado da Oura (diferente do nosso uuid). Os eventos de
-- webhook chegam com esse id, não com o nosso — precisamos dele pra saber
-- de quem é o evento.
alter table public.connections add column if not exists oura_user_id text;
create index if not exists connections_oura_user_id_idx on public.connections (oura_user_id) where provider = 'oura';

-- Cache dos dados da Oura, populado pelo webhook assim que o anel sincroniza
-- com o app (sem precisar esperar o request do navegador). O GET /api/oura
-- lê daqui primeiro; só busca ao vivo na Oura se ainda não houver cache.
create table if not exists public.oura_cache (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  by_date    jsonb not null default '{}'::jsonb,
  last_sleep jsonb,
  updated_at timestamptz not null default now()
);

alter table public.oura_cache enable row level security;
-- (nenhuma policy = só o servidor com service_role acessa, como em "connections")

-- Assinaturas de webhook que criamos na Oura, pra saber o que já existe e
-- poder renovar antes de expirar.
create table if not exists public.oura_webhook_subscriptions (
  id              text primary key,
  data_type       text not null,
  event_type      text not null,
  expiration_time timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.oura_webhook_subscriptions enable row level security;
