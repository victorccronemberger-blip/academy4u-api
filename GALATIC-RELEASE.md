# Galatic: release e ativação

O processo também atende Academy4u. O gate `GALATIC_SALES_ENABLED` controla apenas novas compras Galatic. Em produção, ausência da variável equivale a `false`. Conta, recuperação, consulta de pedidos, webhooks e pós-venda continuam disponíveis com as vendas fechadas.

## Estado comercial desta entrega

Operação em preparação: o CNPJ anterior foi encerrado e o novo cadastro e abastecimento ainda dependem de comprovação externa. Não abrir vendas, anunciar estoque, publicar anúncios pagos ou emitir etiquetas com dados anteriores. Não há fornecedor aprovado por esta alteração.

## Validação antes de publicar

1. Revisar os diffs efetivos de frontend e API e aguardar CI verde nos dois SHAs. API: `npm ci --ignore-scripts`, `npm test`, `npm run build`, `npm run security:audit` e `npm run test:mysql` contra schema sintético local. A integração recusa schema sem prefixo `galatic_test_` e conexão remota.
2. Ensaiar reinício/migração no MySQL compatível, conservar saldos e validar rollback da transação. Os testes não substituem restauração de backup real em ambiente isolado.
3. Confirmar destino de publicação, SHA, banco Galatic e backup restaurável. Não promover apenas porque uma branch recebeu push. Não alterar `ASAAS_ENVIRONMENT`, credenciais Asaas, `PAYMENT_TENANTS`, banco ou origem Academy4u para testar Galatic.
4. Em staging separado, configurar provedor sandbox e contas/dados sintéticos. Provar Pix, cartão 1x/parcelado, timeout após aceite, restart, webhook antecipado/repetido, cancelamento, estorno integral do grupo de parcelas, e-mail e rastreio. Nunca transportar dados completos de cartão/CVV para logs, arquivo, banco ou relatório.
5. Publicar API com `GALATIC_SALES_ENABLED=false` e a chave de criptografia Galatic existente. A chave é obrigatória em produção; trocá-la sem migração torna dados ilegíveis. Publicar o artefato frontend correspondente por GitHub, preservando segredos apenas no servidor. Ver o runbook frontend para geração e crons legados.
6. Verificar `/health` e `/health/galatic` e regressão Academy4u com leituras. Executar `npm run galatic:audit-production`; o novo probe faz somente GET e espera gate fechado. Confirmar banner de preparação, compras bloqueadas e consulta de pedido anterior funcionando no navegador. Esse probe não certifica pagamento nem entrega.

## Condições para abrir as vendas

- Novo cadastro empresarial, documentos fiscais, recebedor de pagamentos, remetente e canais de atendimento conferidos para a nova operação.
- Fornecedores aprovados e condições atuais recebidas; cada SKU com estoque próprio contado ou disponibilidade reservável de parceiro, custo, prazo e processo de avaria/devolução confirmados.
- Preço com margem de contribuição calculada após custo, fretes, embalagem, impostos e taxas reais; não preencher custo desconhecido como zero.
- Peso e medidas da embalagem conferidos e frete ensaiado por destino. O endereço cotado deve coincidir com o enviado à logística.
- Pagamento e pós-venda sandbox aprovados, e-mails de conta/pedido entregues, filas sem falhas pendentes e backup restaurável comprovado.
- Conteúdo comercial/fiscal atualizado e fichas de produto verificadas. Sem inferir número de jogadores de descrições nem chamar curadoria de ranking de vendas.

Depois dessas evidências, habilitar apenas `GALATIC_SALES_ENABLED=true`, reiniciar pelo mecanismo de implantação confirmado e executar `npm run galatic:audit-production -- --sales-state=open`. Uma alteração de flag não substitui as condições acima.

## Recuperação de incidentes

- Checkout persistido antes do POST ao Asaas. `creating`/`uncertain` não autoriza cobrar novamente. Resultado zero na consulta pode ser atraso do provedor; preservar tentativa, chave e reserva até evidência definitiva.
- Migração `financial_operations_v1`: tentativas legadas v0 podem ter enviado POST sem registrar o aceite. Passam conservadoramente a `uncertain/legacy_payment_operation`; revisar uma a uma com evidência do provedor. Não classificá-las como novas reservas v1 seguras para cancelamento nem inventar preço/cartão histórico ausente.
- `GET /v1/galatic/checkout/attempts/:key` recupera resposta sanitizada ou informa processamento. O cliente conserva a chave da tentativa, nunca dados do cartão. Não gerar outra chave para contornar estado pendente.
- Painel owner: `GET /v1/galatic/admin/payment-operations`, `POST /v1/galatic/admin/orders/:id/payment/reconcile` e `GET /v1/galatic/admin/notification-jobs`. Consultar as rotas e permissões no código da versão publicada antes de operar.
- Outbox tem entrega pelo menos uma vez: queda após aceite do e-mail e antes do ACK pode duplicar a mensagem. Falhas possuem retry/lease e precisam de observação operacional. Webhook recebido/deferred não significa evento aplicado.
- Estorno integral de cartão parcelado usa o grupo no Asaas. Em timeout/inconclusivo, consultar antes de repetir; não declarar ao cliente que houve estorno apenas porque ele foi solicitado.
- Alertas antigos do monitor foram encontrados em spam em 23/10/2026. Saúde HTTP verde não comprova recebimento de alertas. Conferir autenticação do remetente e entrega controlada antes da abertura.

## Rollback

Fechar novas vendas e preservar webhooks/pós-venda. A migração aditiva `legacy_catalog_v1` importa somente uma base alvo vazia e sem pedidos; base existente é preservada e marcada. Ela não corrige automaticamente saldos antigos.

**Não iniciar a versão antiga contra o banco migrado sem retirar o importador legado**: o boot antigo pode sobrescrever saldo. Preferir correção adiante na versão migrada; qualquer restauração de banco exige plano que preserve pedidos e eventos posteriores ao backup. Registrar SHA e evidência dos probes, sem credenciais ou dados de clientes.
