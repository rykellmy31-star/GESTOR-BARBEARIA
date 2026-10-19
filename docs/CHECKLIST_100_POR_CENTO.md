# TIGU — Checklist objetivo para operação comercial

> Acompanhar nesta branch de desenvolvimento. **Build verde não significa "100% pronto".** Não habilitar pagamentos, mensagens reais ou liberar clientes antes de concluir os itens obrigatórios.

## Validado no código e por testes automatizados

- [x] Catálogo, agendamentos, controle de conflitos e isolamento das barbearias.
- [x] Carteira de créditos: reserva, captura, estorno e recarga Pix idempotentes no banco.
- [x] Verificação de valor, moeda e referência de Pix com provedor simulado.
- [x] Lembretes agendados, remarcações, cancelamentos e isolamento dos retornos Meta, em simulação.
- [x] Tratamento conservador de timeout de envio (não reenviar sem confirmação).
- [x] Conciliação manual de mensagem incerta, com supervisão e justificativa.
- [x] Contato comercial editável pelo Superadmin, com permissão e possibilidade de ocultar.
- [x] Prévia visual responsiva independente de API com dados fictícios.
- [x] Cadastro de usuário, empresa, assinatura e carteira em uma só transação D1.
- [x] Rotas do Superadmin normalizadas para não duplicar o prefixo HTTP.
- [x] Senha temporária exige alteração antes de acessar os painéis. Recuperação pública em produção não inventa entrega de código que não existe.
- [x] Ambiente de homologação preparado com recursos separados e bloqueio de provedores reais.

## Ainda necessário antes da entrega comercial

### Infraestrutura e implantação (necessita conta Cloudflare autorizada)

- [ ] Criar banco D1, bucket R2 e Worker de homologação na conta Cloudflare.
- [ ] Aplicar migrations remotas no banco **correto**, cadastrar superadmin de teste e configurar secrets exclusivos.
- [ ] Publicar e validar end-to-end login, alteração de senha, cadastro, agenda, catálogo, carrinho, estoque e painéis via URL de homologação.
- [ ] Configurar projeto Cloudflare de produção separado, domínios, cookies, backups, observabilidade, proteção contra abuso e rollback.
- [ ] Confirmar a publicação real do Cloudflare Pages. Build do GitHub não garante que a versão mais recente já está visível no endereço.

### Pagamentos e assinatura (dependências externas)

- [ ] Configurar credenciais e webhook reais do Mercado Pago, testar Pix aprovado, estornado, atrasado e conciliado em banco real.
- [x] Permitir que o Superadmin altere preços e limites de Start/Pro/Scale no D1; a página pública lê os valores atuais do backend.
- [ ] Implementar contratação e cobrança recorrente efetiva dos planos. **Alterar o preço no cadastro não gera boleto, Pix recorrente nem cobrança automática.**
- [ ] Reconciliar valores cobrados ao cliente, custos Meta e margem da plataforma com relatórios financeiros auditáveis.

### WhatsApp e conformidade

- [ ] Validar acesso à Meta Cloud API, aprovação dos modelos de mensagem, onboarding de números por barbearia e condições de faturamento centralizado.
- [ ] Testar disparo/entrega/falha/timeout e consentimento real com números de teste autorizados.
- [ ] Definir rotina operacional de revisão de mensagens incertas, com prazo para desbloquear reservas.
- [ ] Revisar e disponibilizar Termos de Uso, Política de Privacidade, proteção LGPD e aceite explícito no cadastro.
- [ ] Configurar recuperação de acesso self-service com provedor de e-mail transacional ou manter suporte verificado formalmente.
- [ ] Trocar o rate limit em memória por proteção persistente/Cloudflare Turnstile ou equivalente em cadastros e autenticação.
- [ ] Corrigir/avaliar avisos de segurança das dependências com atualização testada.

### Critério para integrar à main

- [ ] CI verde no commit selecionado.
- [ ] Testes end-to-end de homologação aprovados com dados fictícios.
- [ ] Aprovação explícita do proprietário do Tigu antes do merge.
- [ ] Checklist de produção concluído antes de ativar clientes ou recursos financeiros reais.

## Rotina de desenvolvimento

Trabalhar exclusivamente em `audit/tigu-primeira-validacao`, reportar ao proprietário cada alteração visível na prévia visual após finalizar, e atualizar este checklist quando um bloqueio realmente for resolvido. Não alterar o repositório CR Jornada.
