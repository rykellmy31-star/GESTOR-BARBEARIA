# TIGU — Verificação das credenciais Marketplace

Confirmação do usuário: dois segredos de integração cadastrados como GitHub Actions repository secrets.

Este acionamento somente verifica a **presença** dos segredos exigidos, nunca seus valores; consulta em modo somente leitura o esquema da base D1 existente e não realiza deploy ou pagamentos.

O Pix continua desativado enquanto faltarem o Worker, os segredos complementares, o OAuth e o teste de webhook.
