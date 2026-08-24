# Controles de segurança

## Banco de dados e isolamento

O MySQL não oferece Row-Level Security nativa como o PostgreSQL. Esta API aplica o equivalente seguro:

- credenciais do MySQL existem somente no servidor e nunca são enviadas ao frontend;
- Academy4u e Galatic usam bancos e usuários distintos;
- toda consulta de cliente inclui o identificador do proprietário obtido da sessão autenticada;
- valores externos são enviados ao driver como parâmetros, nunca concatenados ao SQL;
- a API seleciona explicitamente os campos retornados e não expõe linhas brutas do banco.

Não existe uma "chave pública do banco" no navegador. Criá-la abriria uma conexão que não é necessária e reduziria a segurança. O frontend acessa apenas endpoints públicos controlados; a API é a única camada com acesso ao MySQL.

## Segredos e dados pessoais

- segredos são variáveis protegidas do ambiente de produção;
- CPF, telefone e endereços da Galatic são cifrados com AES-256-GCM autenticado;
- a chave `GALATIC_DATA_ENCRYPTION_KEY` deve ter 32 bytes e ficar fora do Git; em produção, a API falha no boot em vez de gravar dados pessoais sem criptografia;
- aceites dos termos e da newsletter registram a versão vigente e o instante do consentimento;
- senhas usam `scrypt` com salt individual;
- tokens persistidos no banco são armazenados como hashes opacos;
- o workflow de segurança bloqueia padrões de segredos e dependências vulneráveis.

## Sessões e borda HTTP

- sessões do navegador usam exclusivamente cookies `__Host-`, `HttpOnly`, `Secure`, `SameSite=None`, `Partitioned` e expiração curta; tokens de sessão não são devolvidos ao JavaScript;
- CORS aceita somente as origens registradas de cada tenant;
- produção rejeita HTTP, uploads e corpos que não sejam JSON;
- Helmet, CSP, HSTS, `no-store`, política de permissões e proteção contra MIME sniffing estão ativos;
- autenticação possui limite por IP e por identidade, comparação de senha com tempo uniforme e desafio antibot de uso único;
- campos inesperados são rejeitados para impedir mass assignment.

## Operação

Execute antes de cada publicação:

```sh
npm run security:audit
npm test
```

Se um segredo real for encontrado em qualquer commit, revogue-o primeiro. Só depois reescreva o histórico e force a atualização dos clones. A varredura atual não encontrou segredos reais no histórico deste repositório.
