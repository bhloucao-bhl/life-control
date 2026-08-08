-- ============================================================
-- Life Control — Tuya por usuário (substitui o TUYA_UID único)
-- Cole no Supabase > SQL Editor > New query > Run
-- ============================================================

-- UID da Tuya de cada usuário (a conta Smart Life/Tuya dele, vinculada ao
-- seu projeto Cloud pelo painel da Tuya). Sem isso, o /api/tuya devolve
-- "não conectado" — não existe mais fallback pros dispositivos de outra
-- pessoa.
alter table public.connections add column if not exists tuya_uid text;

-- Preserva o SEU acesso: liga o SEU uid da Tuya (o mesmo valor que já está
-- na variável TUYA_UID da Vercel hoje) à sua própria conta, pra nada mudar
-- no seu uso enquanto os testadores ainda não têm o deles. Troque o e-mail
-- e o UID abaixo pelos seus antes de rodar.
insert into public.connections (user_id, provider, tuya_uid, updated_at)
select id, 'tuya', 'COLOQUE_AQUI_O_MESMO_VALOR_DE_TUYA_UID', now()
from auth.users
where email = 'SEU_EMAIL_DE_LOGIN_AQUI'
on conflict (user_id, provider) do update set tuya_uid = excluded.tuya_uid, updated_at = now();

-- Pra vincular um novo testador depois que ele tiver escaneado o QR no seu
-- painel Tuya (Devices > Link Tuya App Account > Tuya App Account
-- Authorization) e você tiver o UID dele: repita o INSERT acima trocando
-- e-mail e UID. Um novo endpoint pra fazer isso pela tela ainda não existe.
