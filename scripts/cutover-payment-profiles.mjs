import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { cutoverPaymentProfileIndexes } from "../src/store/galatic-payment-profile-store.js";

// Operator-only, never imported by the application or deployment build.
// A new boot/health response is not evidence that old processes terminated.
const evidencePath = process.argv.find((arg) => arg.startsWith("--reviewed-drain-evidence="))?.split("=", 2)[1];
if (!evidencePath || process.env.GALATIC_FINANCIAL_OPERATIONS_ENABLED === "true"
  || !process.env.GALATIC_PROFILE_MIGRATION_MYSQL_URL) throw new Error("Reviewed drain evidence, a closed financial gate and a Galatic migration connection are required");
const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
const connection = await mysql.createConnection(process.env.GALATIC_PROFILE_MIGRATION_MYSQL_URL);
try { await cutoverPaymentProfileIndexes(connection, evidence); console.log("Galatic payment profile namespace cutover completed."); }
finally { await connection.end(); }
