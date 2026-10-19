# Referência da API (Hono · base `/api`)

> **Multiempresa:** rotas de barbearia vivem sob `/api/c/:slug/…` (público), `/api/c/:slug/admin/…` (dono/gerente),
> `/api/c/:slug/barber/…` ou `/api/c/:slug/painel/…` (profissional). A sessão é global (`/api/auth/*`); a empresa é
> resolvida pelo **slug no servidor** e todo repositório filtra por `company_id`. A suíte do operador é `/api/super/*`
> (exige `platform_role=superadmin`). O resto desta tabela usa `/api/…` como abreviação de `/api/c/:slug/…`.

Convenções: JSON; datas em ISO-UTC `YYYY-MM-DDTHH:MM:SSZ`; preços em **centavos** (`price_cents`, com `price` derivado em reais); erros `{error, details?}` com status semântico (400 validação · 401/403 sessão · 404 · 409 conflito de agenda · 422 regras de negócio · 429 rate limit). Sessão via cookie `HttpOnly` (`credentials: "same-origin"`).

## Público (sem sessão)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/config` | `{settings, demo_active}` — subset público das configurações (marca, contatos, horários, políticas) + sinal da tarja demo. |
| GET | `/api/barbers` | Barbeiros ativos (perfil público, rating, especialidade). |
| GET | `/api/barbers/:idOrSlug` | Perfil + serviços que atende + últimas avaliações. |
| GET | `/api/services` | Catálogo ativo (duração, preço, `barber_ids`). |
| GET | `/api/products` | Loja (`stock`, `out_of_stock`, `featured`). |
| GET | `/api/reviews` | Avaliações publicadas (máx. 12 recentes, mais recentes primeiro). |
| GET | `/api/availability?barberId&serviceId&date` | Grade do dia: `{ok, slots:[{t,label}]}` ou `{ok:false, closed_reason}` (`dia_off` · `barbearia_fechada` · `barbeiro_inativo` · `fora_intervalo`; antecedência do dia corrente reduz a grade em vez de gerar motivo próprio). |
| GET | `/api/availability-month?barberId&serviceId&month=YYYY-MM` | Marcadores do calendário: `days:[{day,status}]` (`open/partial/full/day_off`). |

## Agendamento on-line (sem sessão — cliente final)

| Método | Rota | Corpo/Query | Observações |
|---|---|---|---|
| POST | `/api/bookings` | `{serviceId, barberId, startsAt, name, phone, email?, notes?, consent:true, idempotencyKey}` | Valida no servidor (expediente, almoço, folgas, prazos, conflitos). 409 = horário tomado (o site volta p/ grade). `idempotencyKey` (≥ 8 chars) evita duplicidade. Retorna reserva + `cancel_token` + `whatsapp_link` (se configurado). |
| GET | `/api/bookings/lookup?code&phone` | — | Lista reservas do cliente (flags `can_cancel/can_reschedule` calculadas no prazo). |
| POST | `/api/bookings/cancel` | `{code, phone}` | Só dentro do prazo (`cancel_cutoff_min`); libera slots. |
| POST | `/api/bookings/reschedule` | `{code, phone, startsAt}` | Revalida tudo; mantém cliente/notificação do barbeiro. |
| POST | `/api/reviews` | `{code, phone, rating, comment}` | Autentica pelo par protocolo+WhatsApp; só para atendimentos `concluido`, 1 avaliação por reserva; recalcula o rating do barbeiro. O admin pode remover (moderação). |
| POST | `/api/orders` | `{name, phone, items:[{productId, qty}]}` | Loja: cria pedido `novo`, notifica admin e devolve `whatsapp_link` formatado. Sem baixa de estoque (ocorre quando o admin marca `pago`). |

## Auth

`GET /api/auth/status` · `POST /api/auth/login|logout|setup` (setup só existe enquanto não há admin; cria o admin + opcionalmente semeia demo) · `GET /api/auth/me` · `POST /api/auth/password` (troca a própria senha, exige atual). Rate limit: 12 tentativas /15 min por e-mail+IP.

## Painel do barbeiro (`role=barber`)

`GET /api/barber/me` (perfil+permissões) · `GET /api/barber/agenda?from&days` (itens por dia + bloqueios + work_days) · `PATCH /api/barber/bookings/:id/status` (`concluido|no_show|cancelado`, conforme permissões) · `POST /api/barber/confirm/:bookingId` (confirma reserva própria) · `GET|POST /api/barber/block-requests` (pedir bloqueio → aprova admin) · `GET /api/barber/notifications` · `POST /api/barber/notifications/read`.

## Painel admin (`role=admin`)

| Grupo | Rotas |
|---|---|
| Visão | `GET /api/admin/dashboard?from&to` — KPIs do período, série diária (atendimentos×receita), próximos 8, **vagas livres hoje por barbeiro (real, via motor)**. |
| Agenda | `GET /api/admin/agenda?view=day|week|month&date&barberId&q` · `POST /api/admin/bookings` (manual, `notify` opcional) · `PATCH /api/admin/bookings/:id/status` · `POST /api/admin/bookings/:id/reschedule` · `POST /api/admin/blocks` (intervalo) · `DELETE /api/admin/blocks/:id` · `GET|POST|DELETE /api/admin/blocked-days[/id]` (folga/férias/feriado, `barberId:null` = geral) · `GET /api/admin/block-requests` + `:id/approve|reject`. |
| Cadastro | CRUD `/api/admin/barbers` (+ `POST /:id/credentials` cria/renova usuário barbeiro) · `/api/admin/services` (delete = desativa se houver histórico) · `/api/admin/products` (delete idem; `adjust_stock_by`+`stock_reason` movimenta estoque com histórico). |
| Loja | `GET /api/admin/orders?status` · `PATCH /api/admin/orders/:id/status` (`pago` baixa estoque validado; `cancelado` estorna). |
| Clientes | `GET /api/admin/customers?q` · `GET /api/admin/customers/:id` · `POST /api/admin/customers/:id/anonymize` (LGPD). |
| Moderação | `GET /api/admin/reviews` · `DELETE /api/admin/reviews/:id`. |
| Sistema | `GET|PUT /api/admin/settings` (schema zod — ver `api/lib/settings.ts`) · `GET /api/admin/notifications` + `POST /notifications/read` · `GET /api/admin/audit?limit` · `PATCH /api/admin/users/:id`. |
| Demo | `GET /api/admin/demo/status` · `POST /api/admin/demo/reseed` (devolve credenciais demo **uma única vez**) · `DELETE /api/admin/demo`. |

## Uploads

`POST /uploads/upload` (multipart, autenticado) — imagens ≤ 4 MB (`png|jpg|webp|avif`) → R2 (`MEDIA`); em dev local sem R2 caem em `public/uploads` via handler de fallback do Worker. Retorna `{url}` público.

### Exemplo — criar reserva

```bash
curl -sX POST localhost:8787/api/bookings -H 'content-type: application/json' -d '{
  "serviceId":1,"barberId":1,"startsAt":"2026-10-17T12:00:00Z",
  "name":"João","phone":"75999112233","consent":true,"idempotencyKey":"abc123xy"
}'
```
