# Galatic — engenharia de produção para 5.000 usuários simultâneos

Data: 04/09/2026. Requisito do proprietário: pelo menos 5.000 usuários simultâneos.
Estado: diagnóstico inicial e preparação de testes; capacidade NÃO comprovada.

## O que o requisito significa

5.000 pessoas navegando não são 5.000 requisições por segundo, nem 5.000 pagamentos
simultâneos. A mistura de navegação, busca, conta, carrinho, frete e pagamento precisa
ser medida. Com uma interação a cada 10 segundos, são aproximadamente 500 interações
por segundo; uma interação pode gerar várias requisições. Isso é uma hipótese de
dimensionamento, não uma medição da loja. Também é necessário medir downloads de
imagens e execução de JavaScript em navegadores reais.

Manter a identidade visual, o domínio da API e os bancos separados de Academy4u e
Galatic. Reutilizar o código de pagamentos, sem assumir que todos os trabalhos
precisam compartilhar um único processo. Não reescrever o produto inteiro nem adotar
microserviços apenas para mudar o rótulo: a base já é full-stack.

## Baseline inspecionado

- Backend local: `9d12be9`; frontend local: `eb688e0b`. Igualdade com produção ainda
  não revalidada nesta rodada. Não há confirmação atual dos recursos da hospedagem.
- Há Express, MySQL, autenticação no servidor, sessões, transações, bloqueios de
  estoque, controle de tentativas de checkout e deduplicação de webhooks.
- Há CI de testes/build e auditoria de dependências/segredos. Frontend tem workflow
  próprio. Existência do workflow não comprova bloqueio de deploy quando falha.
- A suíte local existente passou: 91 testes, zero falhas. Usa dublês de integrações;
  não é certificação do MySQL ou dos provedores em produção.
- `scripts/stress-tenants.mjs` já testa rajadas locais com banco e provedores falsos.
  Seu resultado não demonstra capacidade de 5.000 clientes reais.
  Reexecutado nesta rodada: 600 requisições locais em paralelo, todas HTTP 200;
  limite de chamadas externas simulado respeitado e excesso rejeitado rapidamente.
- Preparação nova validada: três testes da configuração de carga aprovados,
  validação de build e sintaxe do roteiro aprovadas.

## Lacunas concretas encontradas no código

| Ponto | Evidência | Consequência a validar/corrigir |
| --- | --- | --- |
| Limite de acesso por processo | O fallback de testes continua em memória | Rotas Galatic sensíveis agora usam contador MySQL compartilhado; revisar desafios antibot e migrar para armazenamento dedicado se a medição exigir |
| Migração no início da aplicação | `src/store/galatic-mysql-store.js`: DDL em ensureSchema | Separar migração versionada da inicialização antes de escalar réplicas |
| Banco com fila limitada | `src/store/pool-options.js`: 10 conexões, fila 100 por pool | Medir consultas e espera; dimensionar orçamento total de conexões, não apenas aumentar limites |
| Emissão de etiqueta | `src/services/galatic-fulfillment.js`: consulta, chama Envia, salva | Duas chamadas podem chegar ao provedor antes de existir registro; falha após emissão exige reconciliação |
| Múltiplos volumes | Mesmo serviço seleciona primeiro resultado de etiqueta | Verificar contrato de volumes e persistir/rastrear cada etiqueta quando aplicável |
| E-mail assíncrono | `src/application.js` e rotas públicas: promises após reserva/notificação | Deduplicação não substitui entrega durável após queda do processo |
| Catálogo público | `src/routes/galatic-public.js`: lista completa | Paginação visual não elimina transferência/consulta completa; planejar contrato paginado compatível |
| Frontend exportado e scripts extensos | HTML estático e bridges de conta/loja/admin | Modularizar fonte e geração compartilhada, preservando URLs e design |

## Ordem de implementação e critérios de aprovação

### 1. Ambiente reproduzível e proteção operacional

Inventariar hospedagem real: CPU, memória, workers, limites MySQL, CDN, backups,
processos e custos. Criar homologação isolada com dados sintéticos, provedores falsos
para carga e credenciais sandbox apenas para testes de integração de baixo volume.
Não copiar dados pessoais de clientes. Registrar versão publicada de cada aplicação.

Entrega: ambiente reproduzível, backup com restauração ensaiada e orçamento aprovado
antes de contratar infraestrutura. Definir RPO/RTO; proposta inicial para discussão:
RPO de 15 minutos e RTO de 60 minutos, sem apresentar esses números como garantidos.

### 2. Integridade de compra antes de escala

Persistir uma operação única por pedido/tipo ANTES da emissão externa. Usar estado,
lease e chave de idempotência suportada pelo provedor; tratar resultado incerto com
reconciliação, nunca repetir automaticamente uma emissão/cobrança ambígua. Revisar
reserva/expiração de estoque, estorno, cupons, webhooks fora de ordem e múltiplos volumes.
Manter Pix à vista e cartão até 10x, sendo 1x sem juros ao cliente.

Entrega: testes concorrentes com MySQL real isolado; duas tentativas não geram duas
cobranças/etiquetas; estoque controlado não fica negativo; queda entre confirmação e
gravação é recuperável. Validar Academy4u sem mudar seus métodos de pagamento.

### 3. Trabalhos duráveis e operação com várias instâncias

Introduzir outbox transacional para eventos e tarefas, workers com lease, backoff,
limite de tentativas, fila de falhas e reprocessamento auditável. Não enviar notificações
dependendo apenas da vida do processo HTTP. Coordenar manutenção de pagamentos.
Tornar rate limiting e proteções de uso único compartilhados/atômicos. O semáforo por
processo do provedor também precisa de orçamento global antes de adicionar réplicas.

Entrega: reiniciar uma instância com tarefas em andamento sem perder eventos;
nenhum aumento involuntário de permissões ou de chamadas externas com duas instâncias.

### 4. Consultas, cache e frontend

Aplicar paginação no servidor ao catálogo público com migração compatível do frontend;
medir EXPLAIN, consultas lentas, índices, payloads, lock waits e saturação dos pools.
Não confundir 10 conexões com 10 usuários: conexões são reutilizadas.
Servir arquivos estáticos com CDN e versões imutáveis; cachear apenas dados públicos
com política de invalidação. Preço e estoque finais sempre recalculados no backend.
Nunca cachear conta, sessão, endereço, carrinho privado ou resposta de pagamento.
Dividir módulos JS por função/página e gerar layouts comuns a partir de uma fonte.

Entrega: navegação e conta verificadas em navegador light/dark, sem regressão visual;
catálogo grande não baixa/renderiza tudo; nenhum dado de um cliente chega a outro.

### 5. Segurança, observabilidade e entrega

Revisar autorização por recurso/tenant, administração/MFA, cookies, consultas
parametrizadas, logs sem segredos, validação de campos, dependências e least privilege.
MySQL fica privado: não colocar chave pública de acesso ao banco no frontend.
Rotação de segredos precisa ser coordenada entre consumidores; não revogar a chave
compartilhada deixando Academy4u indisponível.
Instrumentar p95/p99, erros por rota, espera do pool, CPU/memória/event loop, fila e
tempo de entrega dos eventos, reconciliações e provedores. Alertas devem ser testados.
Adicionar promoção homologação -> produção com testes obrigatórios, migração única,
smoke test e rollback compatível com banco. Verificar que auto-deploy não ignora CI.

Entrega: alerta disparado e recebido, restauração executada, regressão dos dois tenants
aprovada e implantação reversível sem apagar dados.

### 6. Evidência de capacidade

Executar 100 -> 500 -> 1.000 -> 2.500 -> 5.000 usuários, sustentar o pico por 30 minutos,
depois ensaio prolongado de 2 horas e teste de recuperação. Propor margem de pico de
7.500 após aprovação do requisito principal. Observar também o gerador de carga.
Misturar jornadas com proporções explícitas e revisar com tráfego observado.

Critérios iniciais de homologação, a confirmar: leituras dinâmicas p95 < 500 ms,
p99 < 1.500 ms, erros inesperados < 0,5%, zero violações de integridade. Medir frete e
pagamento separadamente, pois há latência/limites de terceiros. Testar throttling,
backpressure e comportamento de erro; não omitir 429 inesperados do relatório.

Não fazer teste de carga massivo em Asaas/Envia, nem trocar sandbox/produção para isso.
Integrações reais recebem uma bateria separada, pequena e controlada. Testes HTTP
não substituem E2E em navegador nem testes transacionais de compra.

## Primeira entrega desta rodada: ensaio de leitura local

`performance/catalog.k6.js` lê apenas o catálogo público. Não cria conta, pedido,
pagamento ou etiqueta. Tem validação de resposta, limites de erro/latência e pausa
de 5–15 segundos por usuário. Origens remotas e redirecionamentos estão desabilitados.
O banco do servidor local deve ser isolado/sintético; não usar túneis para produção.

Com k6 instalado e a API isolada em `http://127.0.0.1:3000`:

```powershell
k6 run performance/catalog.k6.js
# Somente depois do smoke aprovado e com monitoramento do host/gerador:
k6 run -e LOAD_PROFILE=capacity -e CONFIRM_LOCAL_CAPACITY=5000 performance/catalog.k6.js
```

O primeiro comando usa 10 usuários por 30 segundos. O segundo é um perfil explícito
de capacidade de LEITURA, não prova do fluxo completo. Homologação remota exigirá
revisão da proteção de origem com o destino autorizado definido, não um bypass.
Nesta rodada k6 não está instalado e o ensaio de capacidade não foi executado.

## Integridade implementada nesta rodada

- A emissão de etiqueta adquire uma operação persistente antes de chamar a Envia.
  Chamadas simultâneas não chegam duas vezes ao provedor. Resposta incerta bloqueia
  retry automático e exige reconciliação, evitando comprar etiqueta em duplicidade.
- Login, checkout, consulta de pedido, cotação de frete e escritas públicas da Galatic
  passam a usar contador MySQL compartilhado. A chave de cliente é SHA-256; o IP não é
  armazenado em texto nessa tabela. Testes e stores simulados preservam fallback local.
- Este é um passo para múltiplas instâncias, não autorização para replicar ainda:
  desafios antibot, workers, pool total e operações externas seguem no plano.
- Dependências vulneráveis encontradas pela auditoria foram atualizadas; a nova
  varredura de dependências terminou sem vulnerabilidades conhecidas pelo npm audit.

Referências de metodologia:
- https://grafana.com/docs/k6/latest/using-k6/thresholds/
- https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/
- https://grafana.com/docs/k6/latest/testing-guides/api-load-testing/
