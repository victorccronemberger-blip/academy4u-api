import { createHash } from "node:crypto";
import { createApp } from "./application.js";

const { app, environment, ready, stores, tenants } = createApp();
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

ready
  .then(() => {
    console.log("Payments API persistent stores are ready.");
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

function shutdown(signal) {
  console.log(`ACADEMY4U API received ${signal}.`);
  server.close(async (error) => {
    try {
      await Promise.all([...stores.values()].map((store) => store.close()));
    } catch (closeError) {
      console.error("ACADEMY4U API could not close its persistent store.", {
        type: closeError?.name,
      });
      error ??= closeError;
    }
    process.exitCode = error ? 1 : 0;
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
