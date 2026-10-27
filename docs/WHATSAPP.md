# WhatsApp na Tigu — integração oficial (Cloud API)

> Resumo honesto: a Tigu fala com a **WhatsApp Business Platform (Cloud API)** da Meta, por empresa.
> Sem credenciais válidas o sistema **não finge envio**: usa modo simulação (explícito na UI) ou o
> link `wa.me` para confirmação manual. Custo de conversa é da barbearia — cobrado via créditos Tigu.

## 1. Como funciona no produto

| Camada | O que a Tigu faz |
|---|---|
| Conexão por empresa | Painel › WhatsApp: `provider=meta_cloud` com **Phone Number ID + token de System User** (criptografado no D1, AES-GCM) ou `mock`/simulação onde habilitado. Toda conexão é **validada na hora** contra a Graph API antes de marcar “conectado”. |
| Templates | Espelho local do que está **aprovado na Meta** (sincronização pela API). O texto enviado é sempre o aprovado; editar aqui não muda o provedor. |
| Fila persistente | `message_jobs` com `scheduled_at`, retries com backoff (config. da plataforma), **idempotência por evento** (`booking-<id>-<kind>-v<versão>`) — sobrevive a restart do Worker. |
| Cobrança | Preço por mensagem (regra global + exceções por empresa) **capturado só quando o provedor aceita o envio** (`capture_on=sent`, padrão) ou na entrega (`delivered`, opcional). Falha definitiva → reserva liberada; entrega posterior à falha não é cobrada retroativamente; estorno manual da suíte é idempotente. |
| Gatilhos | Confirmação (ao reservar, `whatsapp_confirm_enabled`), lembrete N min antes (`reminder_lead_min`, padrão 60; política para lead curto em `short_lead_reminder_policy`), cancelamento/`order_ready` conforme evento. Só envia para cliente com **opt-in** e telefone válido (E.164, 10–15 dígitos). |
| Webhooks | `GET/POST /api/webhooks/whatsapp` — handshake `hub.verify_token`; a empresa é resolvida pelo `phone_number_id`/WABA do payload; eventos de status (sent/delivered/read) atualizam o job e liberam/ajustam cobrança; nada é aplicado duas vezes. |
| Cron | `*/1 * * * *` do Worker chama `processDueJobs` (todas as empresas); a suíte pode forçar um lote em incidentes. |

## 2. O que a Meta exige (checklist real)

1. **Conta Business Manager + WABA** (WhatsApp Business Account). Pode nascer do próprio fluxo Embedded Signup.
2. **Número telefônico** dedicado à automação (não pode estar registrado como conta WhatsApp ativa no
   mesmo app; números fixos servem para SMS/voz de verificação).
3. **App na Meta** com produto *WhatsApp* adicionado. Para uso em produção: revisão da app + **verificação
   da empresa** (selo azul não é obrigatório para enviar, mas aumenta limites).
4. **System User token** (recomendado; permanente) — evita o token de usuário que expira em ~24h.
   Caminho: Business Settings → Users → System Users → criar + atribuir a WABA → gerar token longo com
   `whatsapp_business_messaging` + `whatsapp_business_management`.
5. **Webhook** apontado para `https://SEU-DOMINIO/api/webhooks/whatsapp` com o verify token
   configurado e assinatura do app (`app secret`) conferida pela Tigu nas chamadas de mensagem.
6. **Templates**: caso de uso `UTILITY` (transacional) têm janela gratuita de serviço; criativos `MARKETING`
   custam mais. Envie a redação pela API/BSM e aguarde aprovação (horas a dias).

Versão da API: `GRAPH_API_VERSION` (padrão `v23.0`). A Meta aposenta versões ~2 anos após lançamento
(v23.0 ≥ jan/2027 por ciclo público) — bump é 1 linha de config.

## 3. Cobrança por mensagem (desde jul/2025, modelo template-based)

- Cobrança **por template/mensagem** (não mais por “janela de 24h”): cada mensagem aceita tem taxa do
  tipo do template (utility/marketing/authentication); **utility em “customer service window” aberta
  (cliente respondeu <24h) é gratuita no provedor** — a política de cobrança Tigu continua igual
  (débito por aceite), o que pode deixar a margem maior nesses casos.
- Fora da janela de 24h: só **template aprovado** sai; texto livre só com janela aberta. A Tigu respeita
  isso ao gravar `delivered/read` e recusar conteúdo fora de template quando o provedor responde erro.
- Limites por dia de TIERS (250 → 1k → 10k → ilimitado conversas/dia) sobem conforme volume e qualidade;
  a suíte acompanha porque os erros do provedor entram no job.

## 4. Coexistência com o app WhatsApp Business no balcão

Pergunta clássica do dono: *“meu time usa o app do WhatsApp para atendimento; a automação toma meu número?”*

- **Recomendado (zero risco):** número **dedicado** para a Tigu (ex.: “Canal de Avisos”). O app do balcão
  segue intacto. É o arranjo que a UI sugere primeiro.
- **Coexistência (mesmo número no app + API):** a Meta oferece coexistência para o **WhatsApp Business
  App** com a Cloud API em condições específicas (país, tipo de número, versão do app, WABA elegível).
  **A elegibilidade é verificada pela Meta durante o onboarding** — a Tigu não promete a priori: o painel
  tem o campo “coexistência” (a confirmar / elegível / não elegível) preenchido conforme o resultado do
  teste no fluxo da Meta. Se não elegível, a opção é número dedicado ou migrar o número para a API
  (migração **remove** o número do app — decisão do dono, documentada na UI).
- Atendimento humano 1×1 **pela API** na mesma caixa do app não faz parte do escopo Tigu (notificações
  transacionais apenas). Se um dia houver demanda, a inbox da Meta (Shared Inbox) é o caminho.

## 5. Embedded Signup (onboarding guiado)

Implementado e **guardado por env**: só aparece quando `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET_FOR_OAUTH`
e `WHATSAPP_EMBEDDED_CONFIG_ID` (o *config id* do BSP) existem.

Fluxo: painel → iniciar (abre dialog `whatsapp_business_embedded_signup`) → dono autoriza e a Meta
redireciona com `?code=` → cola o code no painel → Tigu troca via `POST /oauth/access_token`
(`type=authorized_code`, scope `whatsapp_business_messaging`…) → extrai `phone_number_id`/WABA →
cria **System User** e grava conexão (`provider=meta_cloud`, status `pending_setup` → `connected` se a
Graph aceitar). Para operar esse fluxo, a Tigu precisa de um **BSP/app aprovado** com *Embedded Signup
config* ativo — etapa comercial junto à Meta, não de código. Enquanto não houver, a conexão manual faz
exatamente o mesmo, e `docs/WHATSAPP.md §2` é o passo a passo.

## 6. Desenvolvimento/teste local

- `WHATSAPP_MOCK=1` no `.dev.vars`: libera “modo simulação” no painel e o provedor `mock`
  (jobs fluem, zero custo, nenhum HTTP externo).
- Números de teste da Meta (sem verificação de empresa): cadastra até 5 destinos verificados por
  telefone/e-mail e testa envio real antes de qualquer aprovação.
- Smoke: `node scripts/smoke-money.mjs` cobre connect mock → espelho de templates → reserva opt-in →
  fila → run-now → extrato, sem tocar na Meta.

## 7. Segurança & limites

- Tokens nunca voltam para o front (`token_present: true` apenas). Cifra em repouso com `MSG_ENC_KEY`
  (rotação invalida conexões — re-conectar resolve).
- Rate limit por IP nas rotas públicas (agendamento/testes) e por conta no login.
- Erros do provedor são gravados truncados no job e visíveis no painel/suíte; nada de PII em claro em logs.
- Números de destino mascarados na listagem do painel (`5575••••0001`).
