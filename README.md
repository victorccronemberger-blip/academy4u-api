# ACADEMY4U API

Backend financeiro da Academy Cyara. Centraliza cobranças Asaas, preços,
idempotência, webhooks e entrega de matrículas no MySQL compartilhado com o
LMS. O checkout permanece visualmente em `https://academy4u.com.br`.

## Fluxos suportados

- Pix à vista com QR Code e copia-e-cola embutidos.
- Pix parcelado em 2 a 6 parcelas, cada parcela com QR Code consultável pela API.
- Cartão em 1 a 10 parcelas via API Asaas, sem redirecionamento.
- Confirmação assíncrona e deduplicada por webhook.
- Matrícula e histórico financeiro idempotentes no LMS.
- Revogação apenas da matrícula criada por este pedido em caso de estorno ou
  chargeback, preservando acessos anteriores do aluno.

Dados completos de cartão e CVV são transitórios: nunca entram no MySQL, nos
logs nem nas respostas. Como o checkout próprio recebe esses dados, a
infraestrutura da Academy permanece no escopo de conformidade PCI DSS.

## Rotas

| Método | Rota | Uso |
| --- | --- | --- |
| `GET` | `/health` | Saúde do processo e do MySQL |
| `GET` | `/v1/checkout/status` | Ambiente e capacidades do checkout |
| `POST` | `/v1/checkout/installments` | Opções de parcelamento do catálogo legado |
| `POST` | `/v1/checkout/orders` | Cria Pix, Pix parcelado ou cartão |
| `GET` | `/v1/checkout/orders/:id` | Status sanitizado |
| `GET` | `/v1/checkout/orders/:id/pix` | QR Code de um Pix |
| `GET` | `/v1/checkout/orders/:id/installments` | Plano Pix parcelado sem links externos |
| `GET` | `/v1/checkout/orders/:id/installments/:n/pix` | QR Code de uma parcela |
| `POST` | `/v1/webhooks/asaas` | Webhook autenticado e idempotente |
| `POST` | `/v1/galatic/quote` | Cotação Envia com preço e logística autoritativos |
| `GET` | `/v1/galatic/shipping/status` | Estado público do frete (sem segredos) |
| `POST` | `/v1/galatic/admin/orders/:id/shipping/label` | Gera uma única etiqueta Envia para pedido pago |
| `POST` | `/v1/galatic/admin/orders/:id/shipping/refresh` | Reconcilia rastreio sob demanda |
| `POST` | `/v1/galatic/admin/orders/:id/shipping/cancel` | Cancela etiqueta ainda elegível |
| `POST` | `/v1/webhooks/envia` | Webhook de rastreio autenticado e deduplicado |
| `GET` | `/v1/public/products` | Catálogo comercial ativo |
| `POST` | `/v1/public/quote` | Cotação do catálogo comercial |

## Autenticação do checkout

O LMS gera um token Laravel Sanctum de uso curto com a habilidade
`asaas:checkout`. O navegador envia o token no header `Authorization: Bearer`
e apenas IDs de cursos. A API valida o hash diretamente em
`personal_access_tokens`, relê preços, cupom, matrículas e destinatário no
MySQL e revoga o token depois que a cobrança é criada.

Integrações servidor-a-servidor antigas continuam aceitas com
`x-academy-trusted-token`. Toda criação exige `Idempotency-Key` em formato UUID.

## Banco e entrega

As tabelas financeiras usam o prefixo `academy_`. O schema é expandido de forma
aditiva no boot. Para compras originadas no LMS, a confirmação gera, na mesma
transação:

1. `payment_histories` por curso;
2. `enrollments` quando ainda não existe acesso ativo;
3. `academy_order_deliveries` como trilha de idempotência;
4. remoção dos itens correspondentes do carrinho.

No Pix parcelado, a primeira parcela confirmada libera acesso. Estorno ou
chargeback gera lançamento financeiro negativo e remove somente a matrícula
que o pedido criou.

## Configuração

Variáveis ficam somente no painel da Hostinger:

- `MYSQL_URL`
- `ASAAS_ENABLED=true`
- `ASAAS_ENVIRONMENT=sandbox` ou `production`
- `ASAAS_SANDBOX` (chave exclusiva de testes; usada quando o ambiente é `sandbox`)
- `ASAAS_API_KEY` (chave exclusiva de produção)
- `ASAAS_WEBHOOK_TOKEN`
- `ASAAS_SANDBOX_WEBHOOK_TOKEN` (token exclusivo do webhook de sandbox; no sandbox tem precedência sobre o token de produção)
- `TRUSTED_CHECKOUT_TOKEN` (compatibilidade servidor-a-servidor)
- `PUBLIC_ORIGIN=https://academy4u.com.br`

Sandbox e produção possuem chaves e webhooks independentes. O endpoint do
webhook em ambos é:

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

## Validação local

```bash
npm ci
npm test
npm run build
npm start
```
