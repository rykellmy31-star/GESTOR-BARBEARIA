# Operação em produção (dia a dia)

Guia para quem cuida do sistema na barbearia — e para o dev de plantão.

## Rotina recomendada no painel

| Quando | O que fazer |
|---|---|
| Todo dia de manhã | Sino de notificações → confirmar `pendentes`; ajustar agenda se houve falta. |
| Feriado municipal/estadual | Agenda → **Folgas** → bloqueio **Geral** no dia (some do site, inclusive para novos agendamentos). |
| Férias de um barbeiro | Agenda → **Folgas** → selecionar o profissional e o intervalo. |
| Troca de expediente | Painel → **Barbeiros** → dias/horários/almoço (o motor reflete na hora). |
| Fim do mês | Dashboard → período 30d → conferir faturamento; **Pedidos** → status `pago/entregue`. |

## Acesso perdido / troca de senha

- **Esqueci a senha do admin (via painel):** com acesso ao banco (dono do app Cloudflare):

  ```bash
  npx wrangler d1 execute tigu-db --remote \
    --command "UPDATE users SET password_hash='HASH-NOVO' WHERE role='admin' AND email='dono@barbearia.com'"
  ```

  O `HASH-NOVO` vem do mesmo algoritmo do sistema (PBKDF2-SHA256, 210k iterações). O jeito mais fácil: gere-o localmente com o utilitário embutido:

  ```bash
  npx tsx -e "import('./api/lib/crypto.ts').then(async m => console.log(await m.hashPassword('SenhaForte123')))"
  ```

- **Redefinir barbeiro demo/perdido:** painel → Barbeiros → **Senha do painel** (define e-mail + senha temporária de uma vez).
- **Trocar o e-mail de acesso de um usuário:** painel usa `PATCH /api/admin/users/:id` (rota pronta; se precisar via CLI: `UPDATE users SET email='novo@…' WHERE id=?`).

## Backups

- Diariamente (cron simples): `npx wrangler d1 export tigu-db --remote --output backup-$(date +%F).sql`
- Restaurar: `npx wrangler d1 execute tigu-db --remote --file=backup-2026-10-16.sql`
- O R2 (fotos) pode ficar fora do backup de rotina — os registros apontam por URL e os URLs públicos continuam válidos enquanto o bucket existir; para cópia integral use `r2 object put/get` ou o dashboard.
- **Dica de ouro:** mantenha um D1 *staging* e replique lá o export antes de qualquer `UPDATE/DELETE` manual.

## Segurança operacional

- Sessões: cookie `HttpOnly + SameSite=Lax + Secure` com expiração; logout gira o estado. Senhas com PBKDF2 (nunca em claro, nem em log).
- Auditoria: toda mutação de painel cai em `audit_log` (painel → Configurações → rodapé). Inunde o cliente? `npx wrangler tail` mostra os requests em tempo real.
- Não exponha `.dev.vars`/secrets no repo; `wrangler secret put` para valores de produção.
- Limites persistentes no D1 (migração `0006_request_rate_limits.sql`): login por conta com 8 tentativas em 15 minutos; autenticação por IP/rota com 25 tentativas em 5 minutos; novas reservas por IP/barbearia com 12 tentativas em 5 minutos. Bloqueios retornam HTTP 429 e não reiniciam ao trocar de Worker. As chaves são hashes com segredo. Configurar também WAF por domínio antes da operação pública.

## LGPD — respostas rápidas

- **Cliente pede exclusão:** painel → **Clientes** → abrir → **Anonimizar dados** (nome/contato viram marcação; o histórico financeiro fica — base legal para registros fiscais).
- **Portabilidade/cópia:** painel → Clientes → detalhe traz o histórico completo; exporte do dashboard com `d1 query`.
- **Coleta mínima:** no checkout só nome + WhatsApp (+e-mail opcional) e aceite explícito para fins de gestão do agendamento. O consentimento fica registrado no cliente (`customers.lgpd_consent_at`, carimbado no aceite do wizard).

## Monitorando saúde

- **Erros:** `npx wrangler tail` (filtre 5xx) — e o D1 tem limite de 5M linhas lidas/dia no plano Free; a agenda usa índices cobertos, ok para uma loja pequena.
- **Tamanho do banco:** `npx wrangler d1 execute tigu-db --remote --command "SELECT COUNT(*) FROM bookings"`.
- **Slots órfãos?** Impossível por design (`booking_slots` é regravado dentro do mesmo `db.batch` de qualquer criação/remarcação; bloqueio apaga o que for do booking removido).

## Limitações conhecidas (reavaliar conforme crescer)

1. **Notificações**: polling de 12 s no sino — para push real (web push/FCM) é preciso VAPID + service worker (fora de escopo atual).
2. **WhatsApp**: o botão/links funcionam por deep-link (`wa.me`); envio automático de confirmação depende da API oficial da Meta (credenciais + template aprovado).
3. **Pagamento online da loja**: pedido + baixa de estoque existem; checkout com Pix dinâmico/cartão seria uma integração gateway na rota `orders`.
4. **Multi-loja**: o modelo é 1 barbearia (settings/brand por banco). Rede de franquias = 1 par Worker+D1 por unidade (o IaC é idêntico, só muda `name`).
5. Relatórios fiscais/gerenciais avançados (comissões, ranking por período longo): os dados estão todos no D1 (`bookings.status='concluido'` + `price_cents` + `audit`); é uma view nova no painel.


### Atualização de segurança de 19/10/2026

Aplicar a migração `0006_request_rate_limits.sql` no ambiente correto **antes** de publicar o código que usa os limites persistentes. Nenhuma migração remota foi executada durante o desenvolvimento.

O painel da barbearia cria novos acessos; e-mails que já têm conta exigem vínculo seguro pelo suporte/Superadmin até existir fluxo de convite com consentimento. O painel não pode redefinir senha de Superadmin ou conta associada a outras barbearias. Senhas criadas pelo responsável são provisórias e exigem troca no primeiro acesso.
