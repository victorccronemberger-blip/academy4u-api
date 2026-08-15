# Pagamentos multiempresa

Uma implantação da API pode atender Academy4u e Galatic sem compartilhar os
dados de negócio. O Asaas, o código Node e o domínio da API são comuns; banco,
origem pública, token confiável, catálogo, pedidos, webhooks e entrega são
resolvidos dentro do contexto de cada plataforma.

## Isolamento obrigatório

- `ACADEMY4U_MYSQL_URL` e `GALATIC_MYSQL_URL` devem apontar para bancos diferentes.
- Cada plataforma possui origem HTTPS e prefixo financeiro exclusivos.
- A API recusa a inicialização se duas plataformas reutilizarem banco, origem ou prefixo.
- Uma origem Galatic não pode chamar uma rota Academy4u.
- O token do aluno é consultado somente no banco da plataforma selecionada.
- O webhook usa o prefixo financeiro para selecionar o banco antes de persistir o evento.

## Rotas

```text
/v1/platforms/academy4u/checkout/*
/v1/platforms/academy4u/public/*
/v1/galatic/checkout/*
/v1/galatic/quote
/v1/webhooks/asaas
/health
/health/academy4u
/health/galatic
```

As rotas antigas `/v1/checkout/*` e `/v1/public/*` permanecem como aliases da
primeira plataforma configurada para não interromper a Academy4u.

## Autenticação por plataforma

- **Academy4u**: o checkout exige token Sanctum do aluno
  (`Authorization: Bearer`, habilidade `asaas:checkout`, revogado após o uso)
  ou `x-academy-trusted-token` servidor-a-servidor.
- **Galatic**: o frontend é um site estático e chama a API direto do navegador,
  portanto não existe segredo servidor-a-servidor utilizável (qualquer token no
  JavaScript seria público). A proteção do checkout Galatic é feita por
  validação de origem (`tenantOrigin`), rate limit por IP, `Idempotency-Key`
  obrigatório, validação de CPF/CNPJ com dígito verificador e recomputação
  autoritativa de preço, estoque e frete no MySQL. `GALATIC_TRUSTED_CHECKOUT_TOKEN`
  permanece reservado para uma eventual chamada servidor-a-servidor futura.

## Asaas

O ambiente do provedor (`sandbox` ou `production`) é global, pois a mesma
implantação compartilha a integração. Em modo multiempresa ele é controlado
somente pelas variáveis seguras do backend; nenhum banco pode trocar o ambiente
dos demais.

O webhook continua único:

```text
POST https://api.academy4u.com.br/v1/webhooks/asaas
```

O `externalReference` tem o formato `academy:<idempotency-key>` ou
`galatic:<order-id>`. Prefixos desconhecidos são rejeitados antes de
qualquer acesso ao MySQL.

## Galatic (loja de produtos físicos)

O adapter de banco da Galatic (`src/store/galatic-mysql-store.js`) já está
implementado: tabelas `galatic_*` próprias, catálogo físico, cotação de frete
(ViaCEP + Envia.com), controle de estoque transacional e deduplicação de
webhooks. O checkout é exclusivamente Pix à vista; produto físico não gera
matrícula — a confirmação move `fulfillment_status` para `paid`.

Para incluir `galatic` em `PAYMENT_TENANTS`:

1. `GALATIC_PUBLIC_ORIGIN=https://galatic.com.br` e `GALATIC_MYSQL_URL`
   apontando para o banco remoto da loja;
2. `GALATIC_ENVIA_API_KEY` para a cotação de frete;
3. conjunto completo `GALATIC_SHIPPING_*` (remetente/origem das cotações —
   sem ele a rota de frete falha fechada com 503);
4. testes sandbox de Pix para cada plataforma;
5. webhook confirma no banco correto e não toca o outro banco;
6. teste de restauração dos dois backups.
