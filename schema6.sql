-- ============================================================
-- Life Control — sync automático (horário) das compras do Mercado Livre
-- Cole no Supabase > SQL Editor > New query > Run
-- ============================================================

-- Cache das compras do Mercado Livre, populado pelo cron horário
-- (/api/cron/mercadolivre-sync, agendado via GitHub Actions — ver
-- .github/workflows/mercadolivre-sync.yml). O GET /api/mercadolivre lê
-- daqui primeiro; só busca ao vivo no Mercado Livre se ainda não houver
-- cache, se ele estiver velho (>2h, sinal de que o cron parou de rodar), ou
-- se ?refresh=1.
create table if not exists public.ml_purchases_cache (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  purchases  jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.ml_purchases_cache enable row level security;
-- (nenhuma policy = só o servidor com service_role acessa, como em "connections" e "oura_cache")
