# Galatic: release e ativação

O processo também atende Academy4u. O gate `GALATIC_SALES_ENABLED` controla apenas novas compras Galatic. Em produção, ausência da variável equivale a `false`. Conta, recuperação, consulta de pedidos, webhooks e pós-venda continuam disponíveis com as vendas fechadas.

Stage B adiciona [perfis financeiros imutáveis](docs/GALATIC-PAYMENT-PROFILES.md).
O guard financeiro continua fechado. Sem perfil, a API informa ambiente de
pagamento `null` e checkout indisponível, mantendo conta, catálogo, histórico e
e-mail. O cutover destrutivo em produção permanece bloqueado por falta de prova
de término de todos os processos anteriores; boot e health novos não provam dreno.

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

`GET /v1/galatic/admin/readiness` tem escopo `technical_configuration`: `configuration_ready` e seu alias legado `production_ready` verificam apenas configuração técnica, incluindo Asaas e Envia em produção. `sandbox_ready` dispensa somente esses dois ambientes de produção. `sales_enabled` informa separadamente o gate de novas vendas; `checkout_enabled` informa a configuração de pagamento. Custos ausentes e estoque sem gestão aparecem no catálogo como pendências comerciais; custo conhecido, inclusive zero, não comprova margem. Nenhum desses indicadores substitui as evidências de abertura abaixo.

- Novo cadastro empresarial, documentos fiscais, recebedor de pagamentos, remetente e canais de atendimento conferidos para a nova operação.
- Fornecedores aprovados e condições atuais recebidas; cada SKU com estoque próprio contado ou disponibilidade reservável de parceiro, custo, prazo e processo de avaria/devolução confirmados.
- Preço com margem de contribuição calculada após custo, fretes, embalagem, impostos e taxas reais; não preencher custo desconhecido como zero.
- Peso e medidas da embalagem conferidos e frete ensaiado por destino. O endereço cotado deve coincidir com o enviado à logística.
- Cada SKU habilitado deve ter disponibilidade física comprovada para expedição na única origem configurada em `GALATIC_SHIPPING_*`. Abastecimento próprio e de parceiros exige consolidação nessa origem; itens que dependem de envio direto de outra origem permanecem indisponíveis até existir suporte comprovado a cotações e remessas separadas.
- Pagamento e pós-venda sandbox aprovados, e-mails de conta/pedido entregues, filas sem falhas pendentes e backup restaurável comprovado.
- Conteúdo comercial/fiscal atualizado e fichas de produto verificadas. Sem inferir número de jogadores de descrições nem chamar curadoria de ranking de vendas.

Depois dessas evidências, também comprovar o cutover, a identidade do perfil,
suas capacidades e a revisão comercial persistida descritos no contrato Stage B.
Somente uma liberação operacional posterior pode habilitar o guard financeiro e
as vendas. Executar então o probe com `--sales-state=open`. Flags não substituem
esses controles nem autorizam a abertura por esta entrega.

## Recuperação de incidentes

- Checkout persistido antes do POST ao Asaas. `creating`/`uncertain` não autoriza cobrar novamente. Resultado zero na consulta pode ser atraso do provedor; preservar tentativa, chave e reserva até evidência definitiva.
- Migração `financial_operations_v1`: tentativas legadas v0 podem ter enviado POST sem registrar o aceite. Passam conservadoramente a `uncertain/legacy_payment_operation`; revisar uma a uma com evidência do provedor. Não classificá-las como novas reservas v1 seguras para cancelamento nem inventar preço/cartão histórico ausente.
- `GET /v1/galatic/checkout/attempts/:key` recupera resposta sanitizada ou informa processamento. O cliente conserva a chave da tentativa, nunca dados do cartão. Não gerar outra chave para contornar estado pendente.
- Consultas públicas retornam o estado persistido após reconciliação. Pedidos pagos ou encerrados não retornam instruções Pix; cobrança excluída só pode cancelar um pedido ainda não pago pelo fluxo transacional existente. Resposta Pix `200` com apenas `id/status` é válida. Erro/404 do provedor preserva a consulta local do pedido e bloqueia recuperação de QR pendente (`502`), sem inferir migração de ambiente.
- Painel owner: `GET /v1/galatic/admin/payment-operations`, `POST /v1/galatic/admin/orders/:id/payment/reconcile` e `GET /v1/galatic/admin/notification-jobs`. Consultar as rotas e permissões no código da versão publicada antes de operar.
- Outbox tem entrega pelo menos uma vez: queda após aceite do e-mail e antes do ACK pode duplicar a mensagem. Falhas possuem retry/lease e precisam de observação operacional. Webhook recebido/deferred não significa evento aplicado.
- Estorno integral de cartão parcelado usa o grupo no Asaas. Em timeout/inconclusivo, consultar antes de repetir; não declarar ao cliente que houve estorno apenas porque ele foi solicitado.
- O detalhe administrativo expõe `refund_operation` persistido. `refund_authorization_required` com origem `refund_request_response` registra uma indicação recebida na resposta: o Asaas apontou um estorno pendente de autorização no pagamento ou parcelamento relacionado. Verificar os detalhes no painel Asaas. O aviso exige ID exato e uma única entrada de estorno válida com esse status; múltiplas entradas mantêm a resposta genérica. A entrada pode ser anterior ou parcial: não comprova que a nova solicitação exige autorização, o estado atual do provedor ou conclusão financeira. Recarregar preserva esse motivo quando a conciliação é inconclusiva; nenhuma autorização, token ou reenvio automático é realizado. `requested`, `in_progress` e `uncertain` bloqueiam novo POST; somente recusa definitiva preserva a política existente de nova tentativa confirmada. Webhook concluído vence resposta tardia do POST e não gera aviso de solicitação pendente.
- Nova etiqueta exige perfil imutável conhecido, capacidade e prova atual completa do pagamento. Em produção, o perfil também deve ser de produção e ter revisão comercial persistida. ID, referência, método, valor e cliente devem coincidir; cartão parcelado exige grupo completo, paginação encerrada e concordância do anchor com o grupo. Estorno, 404, dados contraditórios, perfil legado desconhecido ou ausência de vínculo histórico de tentativa bloqueiam antes do claim de emissão. Etiquetas já armazenadas continuam consultáveis. Isso não aprova o novo cadastro comercial nem atribui conta a pedidos legados.
- Alertas antigos do monitor foram encontrados em spam em 23/10/2026. Saúde HTTP verde não comprova recebimento de alertas. Conferir autenticação do remetente e entrega controlada antes da abertura.

## Rollback

Fechar novas vendas e o guard financeiro, preservando filas e tentativas para conciliação. Após perfis mistos ou cutover de índices, usar somente builds com suporte a perfis; nunca restaurar o cliente global antigo nem remover vínculos ou índices de namespace. A migração aditiva `legacy_catalog_v1` importa somente uma base alvo vazia e sem pedidos; base existente é preservada e marcada. Ela não corrige automaticamente saldos antigos.

**Não iniciar a versão antiga contra o banco migrado sem retirar o importador legado**: o boot antigo pode sobrescrever saldo. Preferir correção adiante na versão migrada; qualquer restauração de banco exige plano que preserve pedidos e eventos posteriores ao backup. Registrar SHA e evidência dos probes, sem credenciais ou dados de clientes.

# Stage A: financial quiescence before payment-profile migration

`GALATIC_FINANCIAL_OPERATIONS_ENABLED` is closed when absent. Only the exact
literal string `true` opens the captured process gate. Keep it absent or `false`
in production throughout the migration. The Stage A `true` path was transient legacy compatibility for controlled tests.
Stage B additionally requires the immutable profile, verification, capabilities
and namespace phase; the flag cannot restore the old global fallback.

The pause blocks Galatic checkout pricing/creation/recovery, shipping quotes and
provider operations, administrative payment and manual shipping actions,
provider-driven public refresh/Pix, authenticated Asaas/Envia events, and worker
financial selection/claims. Queued work remains intact. Invalid webhook
authentication still returns 401; authenticated events receive retriable 503
before any event receipt is stored. Local catalog/account/history reads and the
notification mail outbox remain available. The default `/v1/checkout` alias uses
the same Galatic router when Galatic is the default tenant. The generic Academy `/v1/public` and `/v1/art` aliases and ART worker are not
mounted or initialized for a Galatic default tenant. Academy keeps its existing
checkout, webhook, ART and LMS runtime behavior.

An owner session may read `GET /v1/galatic/admin/runtime`. It reports only
`releaseRevision`, `sourceFingerprint`, `bootId`, `startedAt`,
`galaticFinancialOperationsEnabled`, and
`galaticFinancialOperationsInFlight`. The same safe fields are logged on Galatic
process startup. The counter covers asynchronous financial workflows and is
released in `finally`, including failures and client disconnects. Nested
workflows can contribute more than one counter unit. The reported boot and
counter concern only the answering process. They cannot enumerate older
processes, workers, alternate domains, or another host.

`npm run build` writes ignored, nonpublic `.build/runtime.json`: revision from
the actual build environment or Git checkout, plus a canonical SHA-256 of source
and package files. Runtime startup does not require Git. Missing or invalid
metadata is reported as null. A revision identifies a build checkout; the source
fingerprint also identifies uncommitted source content. Neither metadata nor
health success proves an old process has stopped.

Fingerprint algorithm: traverse `src/` recursively with ordinal filename ordering
within each directory, then `package.json` and `package-lock.json` in that order.
Hash each relative path with `/` separators, a NUL byte, UTF-8 text normalized
from CRLF to LF, and another NUL byte. The digest uses SHA-256. This makes the
same source tree comparable across Windows and Linux builds.

Before any destructive index/schema cutover, retain explicit lifecycle evidence
that every prior generation and financial worker has stopped and no older
request can apply a result. A completed deployment, successful health check or
one boot with counter zero is insufficient. Check all serving domains/processes
and separately running workers. If the hosting platform cannot provide this
evidence, keep destructive cutover blocked and continue Stage B offline. The
Stage A unit performed no schema/index migration and did not bind historical orders
to a new account/environment. Stage B requires the guard together with the
persisted profile, verified generation, capability and payment evidence; a true
environment flag must never restore a global-provider fallback there.
