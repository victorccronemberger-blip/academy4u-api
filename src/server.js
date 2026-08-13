import { createHash } from "node:crypto";
import { createApp } from "./application.js";

const { app, environment, ready, store } = createApp();
const server = app.listen(environment.port, environment.host, () => {
  console.log(`ACADEMY4U API listening on ${environment.host}:${environment.port}`);
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
    console.log("ACADEMY4U API persistent store is ready.");
  })
  .catch((error) => {
    console.error("ACADEMY4U API could not initialize its persistent store.", {
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
      await store.close();
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
