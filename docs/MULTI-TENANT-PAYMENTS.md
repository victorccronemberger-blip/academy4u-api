# Pagamentos multiempresa

Uma implantação da API pode atender Academy4u e Galatic sem compartilhar os
dados de negócio. O Asaas, o código Node e o domínio da API são comuns; banco,
origem pública, token confiável, catálogo, pedidos, webhooks e entrega são
resolvidos dentro do contexto de cada plataforma.

## Isolamento obrigatório

- `ACADEMY4U_MYSQL_URL` e `GALATIC_MYSQL_URL` devem apontar para bancos diferentes.
- Cada frontend possui seu próprio `*_TRUSTED_CHECKOUT_TOKEN`.
- Cada plataforma possui origem HTTPS e prefixo financeiro exclusivos.
- A API recusa a inicialização se duas plataformas reutilizarem banco, origem ou prefixo.
- Uma origem Galatic não pode chamar uma rota Academy4u.
- O token do aluno é consultado somente no banco da plataforma selecionada.
- O webhook usa o prefixo financeiro para selecionar o banco antes de persistir o evento.

## Rotas

```text
/v1/platforms/academy4u/checkout/*
/v1/platforms/academy4u/public/*
/v1/platforms/galatic/checkout/*
/v1/platforms/galatic/public/*
/v1/webhooks/asaas
/health
/health/academy4u
/health/galatic
```

As rotas antigas `/v1/checkout/*` e `/v1/public/*` permanecem como aliases da
primeira plataforma configurada para não interromper a Academy4u.

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
`galatic:<idempotency-key>`. Prefixos desconhecidos são rejeitados antes de
qualquer acesso ao MySQL.

## Entrada da Galatic

Antes de incluir `galatic` em `PAYMENT_TENANTS`, é obrigatório criar um adapter
de catálogo, identidade e entrega compatível com o schema real da Galatic. A
conexão isolada já está preparada, mas não se deve apontar a API para um banco
cujo schema ainda não foi mapeado.

Critérios de ativação:

1. schema e migrations da Galatic documentados;
2. adapter de catálogo e concessão/revogação de acesso testado;
3. token servidor-servidor diferente do Academy4u;
4. testes sandbox dos três métodos para cada plataforma;
5. webhook confirma no banco correto e não toca o outro banco;
6. teste de restauração dos dois backups.
