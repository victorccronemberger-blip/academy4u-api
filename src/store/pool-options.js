// Opções endurecidas para os pools mysql2. O host é compartilhado: sem esses
// limites, uma lentidão do MySQL faz as requisições se acumularem numa fila
// interna ilimitada e derruba o processo por memória/latência em cascata.
// - connectionLimit/queueLimit: falha rápida ("Queue limit reached") em vez de
//   enfileirar requisições para sempre; a fila dá folga para rajadas curtas.
// - connectTimeout: uma tentativa de conexão nunca segura um slot por mais de
//   5s esperando o TCP responder.
// - enableKeepAlive: evita que o servidor MySQL encerre conexões ociosas e
//   devolva ECONNRESET na primeira query após um período parado.
// - maxIdle/idleTimeout: devolve conexões ociosas ao servidor em vez de manter
//   o pool inteiro aberto fora de pico.
export function hardenedPoolOptions() {
  return {
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 100,
    connectTimeout: 5_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
    maxIdle: 5,
    idleTimeout: 60_000,
  };
}

// mysql2 sinaliza fila cheia com erro de message conhecido, sem code próprio.
export function isPoolQueueFullError(error) {
  return typeof error?.message === "string" && error.message.includes("Queue limit reached");
}
