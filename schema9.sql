-- ============================================================
-- Life Control — dados extras da Oura (SpO2, FC contínua, estresse...)
-- Cole no Supabase > SQL Editor > New query > Run
-- ============================================================

-- O que a Oura devolve e não é "um valor por dia" (esses vão em by_date e no
-- health_daily): curva de frequência cardíaca das últimas 24h, perfil
-- (idade/sexo/altura/peso), horário ideal de dormir, modo descanso em
-- andamento e o status de cada endpoint (pra saber se falta escopo).
-- Ver fetchOuraData/saveOuraCache em lib/oura.js.
alter table public.oura_cache add column if not exists extra jsonb;
