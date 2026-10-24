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

// Nonpublic deployment metadata is generated from the actual checkout. Runtime
// startup remains independent of Git and reports null if metadata is unavailable.
const root = fileURLToPath(new URL("..", import.meta.url));
const sourceHash = createHash("sha256");
async function fingerprint(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await fingerprint(target);
    else {
      sourceHash.update(path.relative(root, target).replaceAll("\\", "/"));
      sourceHash.update("\0"); sourceHash.update((await readFile(target, "utf8")).replaceAll("\r\n", "\n")); sourceHash.update("\0");
    }
  }
}
await fingerprint(path.join(root, "src"));
for (const file of ["package.json", "package-lock.json"]) {
  sourceHash.update(file); sourceHash.update("\0"); sourceHash.update((await readFile(path.join(root, file), "utf8")).replaceAll("\r\n", "\n")); sourceHash.update("\0");
}
let releaseRevision = process.env.GITHUB_SHA || process.env.RELEASE_REVISION || null;
if (!/^[a-f0-9]{40}$/.test(releaseRevision ?? "")) {
  try { releaseRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { releaseRevision = null; }
}
if (!/^[a-f0-9]{40}$/.test(releaseRevision ?? "")) releaseRevision = null;
await mkdir(path.join(root, ".build"), { recursive: true });
await writeFile(path.join(root, ".build/runtime.json"), JSON.stringify({ releaseRevision, sourceFingerprint: sourceHash.digest("hex") }) + "\n");

console.log("ACADEMY4U API source validated.");
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
