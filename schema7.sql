-- ============================================================
-- Life Control — passos do Apple Health (HealthKit) visíveis no desktop/web
-- Cole no Supabase > SQL Editor > New query > Run
-- ============================================================

-- Cache dos passos lidos do HealthKit pelo app iOS (só ele tem acesso de
-- verdade ao HealthKit — é uma API nativa, não existe no navegador). O app
-- iOS grava aqui (POST /api/healthkit-steps) toda vez que lê dados novos do
-- Apple Health; a versão desktop/web só lê (GET /api/healthkit-steps), pra
-- mostrar os mesmos passos sem ter como acessar o HealthKit diretamente.
create table if not exists public.healthkit_steps_cache (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  by_date    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.healthkit_steps_cache enable row level security;
-- (nenhuma policy = só o servidor com service_role acessa, como em "connections" e "oura_cache")
