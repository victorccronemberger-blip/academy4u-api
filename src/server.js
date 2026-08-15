import { createHash } from "node:crypto";
import { createApp } from "./application.js";
import { createGalaticPaymentMaintenance } from "./services/galatic-payment-maintenance.js";

const { app, environment, ready, stores, tenants, asaasClient, contexts, galaticNotifications } = createApp();
const galaticContext = contexts.get("galatic");
const paymentMaintenance = galaticContext ? createGalaticPaymentMaintenance({
  environment: galaticContext.environment, store: galaticContext.store, asaasClient, notifications: galaticNotifications,
}) : null;
const server = app.listen(environment.port, environment.host, () => {
  console.log(`Payments API listening on ${environment.host}:${environment.port}`, {
    tenants: tenants.map((tenant) => tenant.id),
  });
  if (environment.asaasApiKey) {
    console.log("ACADEMY4U API provider credential loaded.", {
      environment: environment.asaasEnvironment,
      length: environment.asaasApiKey.length,
      fingerprint: createHash("sha256").update(environment.asaasApiKey).digest("hex").slice(0, 12),
    });
  }
});

// Hardening do servidor HTTP: sem esses limites, conexões lentas/ocupadas
// seguram sockets do processo por tempo indeterminado e um cliente travado
// pode esgotar os recursos do host compartilhado.
// keepAliveTimeout fica acima do idle timeout típico de proxies (60s) para o
// proxy encerrar primeiro e evitar corrida de reuso de conexão.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
// Teto total por requisição: nenhuma rota desta API deve demorar mais que a
// chamada mais lenta ao provedor de pagamento (65s).
server.requestTimeout = 75_000;

ready
  .then(() => {
    console.log("Payments API persistent stores are ready.");
    paymentMaintenance?.start();
  })
  .catch((error) => {
    console.error("Payments API could not initialize its persistent stores.", {
      code: error?.code,
      errno: error?.errno,
      sqlState: error?.sqlState,
      message: error?.message,
      type: error?.name,
    });
  });

let shuttingDown = false;

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  paymentMaintenance?.stop();
  console.log(`ACADEMY4U API received ${signal}.`);
  // Libera imediatamente as conexões keep-alive ociosas; sem isso o
  // server.close() pode aguardar minutos por sockets que nunca fecham.
  server.closeIdleConnections?.();
  // Se o dreno ordenado não concluir (ex.: requisição longa em voo), força a
  // saída para o orquestrador poder reiniciar o processo.
  const forceExit = setTimeout(() => {
    console.error("ACADEMY4U API graceful shutdown timed out; forcing exit.");
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  server.close(async (error) => {
    clearTimeout(forceExit);
    try {
      await Promise.all([...stores.values()].map((store) => store.close()));
    } catch (closeError) {
      console.error("ACADEMY4U API could not close its persistent store.", {
        type: closeError?.name,
      });
      error ??= closeError;
    }
    process.exitCode = error ? 1 : exitCode;
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// Falhas assíncronas não tratadas não devem derrubar o processo em silêncio:
// registram com contexto e seguem. Já uma exceção síncrona não capturada deixa
// o estado do processo imprevisível — registra e inicia shutdown controlado.
process.on("unhandledRejection", (reason) => {
  console.error("ACADEMY4U API unhandled promise rejection.", {
    type: reason?.name,
    code: reason?.code,
    message: reason?.message,
  });
});
process.on("uncaughtException", (error) => {
  console.error("ACADEMY4U API uncaught exception; shutting down.", {
    type: error?.name,
    code: error?.code,
    message: error?.message,
    stack: error?.stack,
  });
  shutdown("uncaughtException", 1);
});
