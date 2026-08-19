-- ============================================================
-- Life Control — histórico permanente de saúde + memória do Dr. Claude
-- Cole no Supabase > SQL Editor > New query > Run
-- ============================================================

-- Histórico diário de saúde, um registro por usuário por dia, que NUNCA é
-- sobrescrito por inteiro — cada gravação funde (merge raso) os campos novos
-- por cima dos que já existiam pra aquele dia. Isso é diferente de
-- oura_cache/healthkit_steps_cache: aquelas tabelas são só um cache "das
-- últimas ~2 semanas" que a Oura/HealthKit devolvem numa chamada, e cada
-- atualização SUBSTITUI o cache inteiro — então dado de dias mais antigos
-- que a janela da chamada acaba se perdendo dali. health_daily é o registro
-- histórico de verdade: uma vez que um dia é gravado aqui (readiness, sono,
-- passos, etc.), ele fica pra sempre, e novas fontes (Oura, HealthKit,
-- entradas manuais futuras) só acrescentam/atualizam campos daquele mesmo
-- dia sem apagar os outros.
--
-- "metrics" guarda campos como: readiness, sleep, activity, steps,
-- tempDeviation (todos vindos hoje da Oura) e é o lugar certo pra qualquer
-- fonte futura (Apple Health além de passos, pesagem, etc.) acrescentar o
-- que tiver pra aquele dia.
create table if not exists public.health_daily (
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date not null,
  metrics    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

create index if not exists health_daily_user_date_idx on public.health_daily (user_id, date desc);

alter table public.health_daily enable row level security;
-- (nenhuma policy = só o servidor com service_role acessa, como em "connections"/"oura_cache")

-- Histórico (append-only) das conversas com o Dr. Claude/Claude — permite que
-- o assistente tenha memória entre sessões em vez de começar do zero toda vez
-- que o app é reaberto. Cada linha é uma mensagem (do usuário ou da IA);
-- quem lê monta o contexto a partir das últimas N linhas por usuário.
create table if not exists public.dr_claude_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);

create index if not exists dr_claude_messages_user_created_idx on public.dr_claude_messages (user_id, created_at desc);

alter table public.dr_claude_messages enable row level security;
-- (nenhuma policy = só o servidor com service_role acessa, como em "connections"/"oura_cache")
