# ACADEMY4U API

Backend financeiro da Academy Cyara. Centraliza cobranÃ§as Asaas, preÃ§os,
idempotÃªncia, webhooks e entrega de matrÃ­culas no MySQL compartilhado com o
LMS. O checkout permanece visualmente em `https://academy4u.com.br`.

## Fluxos suportados

- Pix Ã vista com QR Code e copia-e-cola embutidos.
- Pix parcelado em 2 a 6 parcelas, cada parcela com QR Code consultÃ¡vel pela API.
- CartÃ£o em 1 a 10 parcelas via API Asaas, sem redirecionamento.
- ConfirmaÃ§Ã£o assÃ­ncrona e deduplicada por webhook.
- MatrÃ­cula e histÃ³rico financeiro idempotentes no LMS.
- RevogaÃ§Ã£o apenas da matrÃ­cula criada por este pedido em caso de estorno ou
  chargeback, preservando acessos anteriores do aluno.

Dados completos de cartÃ£o e CVV sÃ£o transitÃ³rios: nunca entram no MySQL, nos
logs nem nas respostas. Como o checkout prÃ³prio recebe esses dados, a
infraestrutura da Academy permanece no escopo de conformidade PCI DSS.

## Rotas

| MÃ©todo | Rota | Uso |
| --- | --- | --- |
| `GET` | `/health` | SaÃºde do processo e do MySQL |
| `GET` | `/v1/checkout/status` | Ambiente e capacidades do checkout |
| `POST` | `/v1/checkout/installments` | OpÃ§Ãµes de parcelamento do catÃ¡logo legado |
| `POST` | `/v1/checkout/orders` | Cria Pix, Pix parcelado ou cartÃ£o |
| `GET` | `/v1/checkout/orders/:id` | Status sanitizado |
| `GET` | `/v1/checkout/orders/:id/pix` | QR Code de um Pix |
| `GET` | `/v1/checkout/orders/:id/installments` | Plano Pix parcelado sem links externos |
| `GET` | `/v1/checkout/orders/:id/installments/:n/pix` | QR Code de uma parcela |
| `POST` | `/v1/webhooks/asaas` | Webhook autenticado e idempotente |
| `GET` | `/v1/public/products` | CatÃ¡logo comercial ativo |
| `POST` | `/v1/public/quote` | CotaÃ§Ã£o do catÃ¡logo comercial |

## AutenticaÃ§Ã£o do checkout

O LMS gera um token Laravel Sanctum de uso curto com a habilidade
`asaas:checkout`. O navegador envia o token no header `Authorization: Bearer`
e apenas IDs de cursos. A API valida o hash diretamente em
`personal_access_tokens`, relÃª preÃ§os, cupom, matrÃ­culas e destinatÃ¡rio no
MySQL e revoga o token depois que a cobranÃ§a Ã© criada.

IntegraÃ§Ãµes servidor-a-servidor antigas continuam aceitas com
`x-academy-trusted-token`. Toda criaÃ§Ã£o exige `Idempotency-Key` em formato UUID.

## Banco e entrega

As tabelas financeiras usam o prefixo `academy_`. O schema Ã© expandido de forma
aditiva no boot. Para compras originadas no LMS, a confirmaÃ§Ã£o gera, na mesma
transaÃ§Ã£o:

1. `payment_histories` por curso;
2. `enrollments` quando ainda nÃ£o existe acesso ativo;
3. `academy_order_deliveries` como trilha de idempotÃªncia;
4. remoÃ§Ã£o dos itens correspondentes do carrinho.

No Pix parcelado, a primeira parcela confirmada libera acesso. Estorno ou
chargeback gera lanÃ§amento financeiro negativo e remove somente a matrÃ­cula
que o pedido criou.

## ConfiguraÃ§Ã£o

VariÃ¡veis ficam somente no painel da Hostinger:

- `MYSQL_URL`
- `ASAAS_ENABLED=true`
- `ASAAS_ENVIRONMENT=sandbox` ou `production`
- `ASAAS_SANDBOX` (chave exclusiva de testes; usada quando o ambiente é `sandbox`)
- `ASAAS_API_KEY` (chave exclusiva de produção)
- `ASAAS_WEBHOOK_TOKEN`
- `ASAAS_SANDBOX_WEBHOOK_TOKEN` (token exclusivo do webhook de sandbox; no sandbox tem precedência sobre o token de produção)
- `TRUSTED_CHECKOUT_TOKEN` (compatibilidade servidor-a-servidor)
- `PUBLIC_ORIGIN=https://academy4u.com.br`

Sandbox e produÃ§Ã£o possuem chaves e webhooks independentes. O endpoint do
webhook em ambos Ã©:

```text
https://api.academy4u.com.br/v1/webhooks/asaas
```

### Chave operacional no LMS

Quando presentes, os registros `academy_asaas_environment` e
`academy_asaas_production_webhook_sha256` da tabela `settings` substituem apenas
o modo operacional e a validação do webhook de produção. As chaves de API
continuam existindo exclusivamente nas variáveis da Hostinger. O token do
webhook também não é salvo no banco: somente seu SHA-256 irreversível.

Isso permite promover ou reverter o checkout sem copiar segredos e sem ficar
dependente da disponibilidade visual do hPanel. Valores aceitos para
`academy_asaas_environment`: `sandbox` e `production`.

## ValidaÃ§Ã£o local

```bash
npm ci
npm test
npm run build
npm start
```
