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

Na Galatic, a política é deliberadamente mais restrita: somente Pix à vista e
cartão de crédito de 1 a 10 parcelas. Boleto, dinheiro, Pix parcelado e qualquer
outro meio são rejeitados no servidor antes de chamar o Asaas. O valor de cada
parcela é calculado a partir das condições retornadas pelo provedor, com o custo
financeiro repassado ao comprador.

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
| `POST` | `/v1/galatic/admin/orders/:id/payment/cancel` | Remove cobrança não paga e libera o estoque de forma idempotente |
| `POST` | `/v1/galatic/admin/orders/:id/payment/refund` | Solicita estorno integral confirmado pelo número do pedido |

Reservas Pix abandonadas são reconciliadas com o Asaas após 60 minutos; cartões em análise usam uma janela conservadora de 72 horas. A cobrança é consultada e removida no provedor antes de o estoque voltar ao catálogo. Os limites podem ser ajustados com `GALATIC_PIX_RESERVATION_MINUTES` e `GALATIC_CARD_RESERVATION_MINUTES`.
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

## Matrícula na ART (principal) com fallback LMS

A partir de um pedido pago (webhook Asaas confirmado), o fluxo `onAccessGranted`
tenta **primeiro** ativar a matrícula na plataforma ART (academiarafaeltoro.com.br)
na conta do próprio aluno:

1. `academy_art_mappings` traduz o `course_id` do LMS → tag/turma/id_curso da ART.
2. `createArtClient` (src/integrations/art/client.js) ativa na conta ART do aluno:
   - **Conta já existe com senha = CPF** → login direto (reuso, sem provision).
   - **Conta nova** → provision + checkout + flip (fluxo validado).
   - **Curso já ativo na conta** → detecta e não cria ordem duplicada.
   - **Conta existe mas senha desconhecida** (criada externamente ou senha
     trocada pela plataforma) → `existing_account_no_access`: registra auditoria
     + alerta dedicado e cai para o LMS (o aluno não fica sem acesso).
3. `createArtActivationService` (src/services/art-activation.js) orquestra:
   - Sucesso → registra em `academy_art_activations` (status `activated`) e a
     matrícula **não** é duplicada no LMS (o aluno acessa o curso na ART).
   - Item sem mapping, falha ou timeout → registra `failed`/`error` + alerta
     operacional e **cai para o LMS** (comportamento atual), garantindo acesso.
4. `grantOrderAccess` pula itens já entregues na ART (sem enrollment LMS
   duplicada) mas mantém o histórico financeiro (`payment_histories`).

### Configuração

- `ART_ENABLED=true` — liga a ativação ART como principal.
- Mapeamentos: tabela `academy_art_mappings` (popule com
  `node scripts/seed-art-mappings.mjs mapping.json` ou pelas rotas admin).
- Rotas admin (header `x-academy-trusted-token`):
  - `GET/POST /v1/art/mappings` · `DELETE /v1/art/mappings/:courseId`
  - `GET /v1/art/activations` (auditoria)
- Em produção, a ART é chamada com `ip_usuario` fictício (TEST-NET) — nunca o IP
  do servidor. A conta ART do aluno usa email + CPF dele; se a plataforma trocar
  a senha (e-mail de matrícula), o fallback LMS cobre sem quebrar o pedido.

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
