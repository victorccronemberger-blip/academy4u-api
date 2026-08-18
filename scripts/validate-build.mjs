await Promise.all([
  import("../src/application.js"),
  import("../src/store/in-memory-store.js"),
  import("../src/store/mysql-store.js"),
  import("../src/store/order-status.js"),
  import("../src/config/environment.js"),
  import("../src/http/error-handler.js"),
  import("../src/http/request-context.js"),
  import("../src/domain/catalog.js"),
  import("../src/domain/payment-status.js"),
  import("../src/domain/provider-values.js"),
  import("../src/domain/quote.js"),
  import("../src/integrations/asaas/client.js"),
  import("../src/integrations/art/client.js"),
  import("../src/services/installment-service.js"),
  import("../src/services/art-activation.js"),
  import("../src/routes/asaas-integration.js"),
  import("../src/routes/checkout.js"),
  import("../src/routes/art-admin.js"),
  import("../src/routes/health.js"),
  import("../src/routes/public.js"),
]);

// Guard defensivo: mantém fora do código qualquer padrão de token não assinado
// (alg=none) ou de forja de JWT de transporte, caso código legado seja
// reintroduzido.
const forbiddenSource = /\b(?:alg\s*[:=]\s*["']none|forgeTransportJwt)\b/i;
async function assertNoUnsafeCode(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertNoUnsafeCode(target);
    else if (entry.name.endsWith(".js") && forbiddenSource.test(await readFile(target, "utf8"))) {
      throw new Error(`Unsafe transport code found in ${target}.`);
    }
  }
}
await assertNoUnsafeCode(fileURLToPath(new URL("../src", import.meta.url)));

console.log("ACADEMY4U API source validated.");
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
