# Sync automático do Oura — o que falta configurar

Este documento é só pra você (não faz parte do código, é um checklist). O código já
está pronto na branch `claude/oura-ring-auto-sync-2zihq8`; faltam 3 passos manuais
que só você consegue fazer (acesso ao Supabase e à Vercel).

## O que isso resolve

Antes: o app só via dados novos do Oura quando você abria o app oficial da Oura no
celular e voltava pro life-control.

Agora: o backend assina os **webhooks** da Oura. Assim que o anel sincroniza com o
app da Oura (mesmo em segundo plano, sem você abrir nada), a Oura avisa nosso
servidor e os dados são recarregados na hora.

## Passo 1 — Rodar o `schema3.sql` no Supabase

1. Abra o [Supabase](https://supabase.com/dashboard) → seu projeto → **SQL Editor** → **New query**.
2. Cole todo o conteúdo do arquivo `schema3.sql` (na raiz do repo).
3. Clique **Run**.

Isso cria:
- a coluna `oura_user_id` na tabela `connections` (id do usuário do lado da Oura,
  usado pra casar os eventos de webhook com sua conta);
- a tabela `oura_cache` (onde os dados ficam prontos, populados pelo webhook);
- a tabela `oura_webhook_subscriptions` (registro do que já foi assinado).

## Passo 2 — Criar a variável de ambiente na Vercel

1. Gere um valor aleatório qualquer pra usar como segredo. Pode gerar assim no
   terminal:
   ```bash
   openssl rand -hex 32
   ```
2. Na Vercel → seu projeto → **Settings** → **Environment Variables**, crie:
   - **Nome:** `OURA_WEBHOOK_VERIFICATION_TOKEN`
   - **Valor:** o texto aleatório gerado no passo anterior
   - **Environments:** Production (e Preview, se quiser testar antes)
3. Confirme que `OURA_CLIENT_ID` e `OURA_CLIENT_SECRET` já existem (são as mesmas
   usadas hoje pra conectar o Oura — se o botão "Conectar" do Oura já funciona,
   elas já estão lá).

## Passo 3 — Deploy

Depois que o PR for mesclado (ou você mandar a branch pra produção), faça o deploy
normal na Vercel. As env vars novas só valem a partir do próximo deploy.

## Passo 4 — Ativar as assinaturas

1. Abra o life-control → **Configurações** → seção **Conexões**.
2. Confirme que o Oura Ring está **conectado** (se não estiver, conecte primeiro).
3. Vai aparecer um card **"Sync automático do Oura"** logo abaixo — clique em
   **Ativar**.
4. Deve aparecer algo como `Criadas: 8 · já existiam: 0`. Se aparecer algum erro,
   me avise com a mensagem exata que apareceu.

Isso só precisa ser feito **uma vez** (rodar de novo não duplica nada — o botão é
seguro pra clicar mais de uma vez).

## Passo 5 — Conferir (opcional)

- `GET /api/oura/subscribe` (autenticado, mesma sessão do app) lista as assinaturas
  ativas direto na Oura.
- Na tabela `oura_webhook_subscriptions` do Supabase você vê o que foi criado por
  aqui.
- Depois que o anel sincronizar de novo com o app da Oura, a tabela `oura_cache`
  deve atualizar o `updated_at` sozinha, sem você ter aberto o life-control.

## Bônus (iOS) — deixa o sync automático do próprio app da Oura mais confiável

Isso não depende do nosso código, é configuração do iPhone:

1. Ajustes do iPhone → **Oura** → ligar **Atualização em Segundo Plano**.
2. Confirme que **Modo de Baixo Consumo** está desligado.
3. Bluetooth sempre ligado.
4. Abra o app da Oura pelo menos uma vez por dia (a própria Oura recomenda isso
   pra manter o sync automático funcionando).

## Limitação conhecida (transparência)

A Oura documenta um header `x-oura-signature` pra autenticar os eventos de
webhook, mas o algoritmo exato não estava acessível nas fontes que consultei (a
documentação oficial em `cloud.ouraring.com` / `api.ouraring.com` ficou bloqueada
no ambiente onde implementei isso). Por isso, por enquanto, o endpoint **não**
valida essa assinatura — a segurança fica só no `verification_token` do handshake
inicial. Na prática o risco é baixo (um evento forjado no máximo dispara um
refresh usando o *seu próprio* token já salvo, não vaza nem escreve nada), mas é
um ponto pra reforçar depois de testar contra um evento real da Oura em produção.
Se quiser, me avise quando o webhook já tiver recebido eventos reais e eu ajusto
a validação da assinatura.
