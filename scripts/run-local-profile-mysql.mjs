import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import mysql from "mysql2/promise";

// Explicit local-only developer harness; never loads application/environment
// files, existing datadirs or retained database credentials.
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = path.resolve(option("mysql-base") ?? "missing-mysql-base");
const runtimeRoot = path.resolve(option("runtime-root") ?? "missing-runtime-root");
if (!option("mysql-base") || !option("runtime-root")) throw new Error("Explicit mysql-base and runtime-root are required");
const port = 33081;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once("error", reject);
  probe.listen(port, "127.0.0.1", () => probe.close(resolve)); });
const runDir = path.join(runtimeRoot, `mysql-profile-test-${randomUUID()}`);
const dataDir = path.join(runDir, "data");
await mkdir(dataDir, { recursive: true });
const log = await open(path.join(runDir, "server.log"), "a");
const binary = path.join(base, "bin", "mysqld.exe");
const common = ["--no-defaults", `--basedir=${base}`, `--datadir=${dataDir}`];
const waitExit = (child) => new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
let server; let connection; let exitCode = 1;
try {
  const initialize = spawn(binary, [...common, "--initialize-insecure", "--console"], { windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
  if (await waitExit(initialize)) throw new Error("Disposable MySQL initialization failed");
  server = spawn(binary, [...common, "--no-monitor", "--console", "--bind-address=127.0.0.1", `--port=${port}`, "--mysqlx=OFF", "--skip-log-bin"],
    { windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
  let lastError;
  for (let index = 0; index < 60; index += 1) {
    if (server.exitCode !== null) throw new Error("Owned disposable MySQL exited before readiness");
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)`], { windowsHide: true });
    const owners = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    if (owners.some((pid) => pid !== server.pid)) throw new Error("Refuse connection: local port is not exclusively owned by this test process");
    if (!owners.includes(server.pid)) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try { connection = await mysql.createConnection({ host: "127.0.0.1", port, user: "root", connectTimeout: 500 }); break; }
    catch (error) { lastError = error.code; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!connection) throw new Error(`Disposable MySQL unavailable: ${lastError}`);
  const password = randomBytes(32).toString("hex");
  await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [password]);
  const schema = `galatic_test_profile_${randomBytes(6).toString("hex")}`;
  await connection.query(`CREATE DATABASE ${schema}`);
  const url = `mysql://root:${password}@127.0.0.1:${port}/${schema}`;
  const tests = spawn(process.execPath, ["--test", "--test-reporter=tap", "tests/galatic-mysql.integration.test.mjs"], {
    cwd: process.cwd(), windowsHide: true, env: { ...process.env, MYSQL_TEST_URL: url }, stdio: "inherit",
  });
  exitCode = await waitExit(tests);
} finally {
  if (connection) { await connection.query("SHUTDOWN").catch(() => {}); await connection.end().catch(() => {}); }
  if (server && server.exitCode === null) {
    await Promise.race([waitExit(server), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (server.exitCode === null) { server.kill(); await waitExit(server); }
  }
  await log.close();
  const resolvedData = path.resolve(dataDir); const expectedParent = path.resolve(runDir) + path.sep;
  if (!resolvedData.startsWith(expectedParent) || path.basename(resolvedData) !== "data"
    || !path.basename(runDir).startsWith("mysql-profile-test-")) throw new Error("Refuse unsafe cleanup target");
  await rm(resolvedData, { recursive: true, force: true });
  console.log(JSON.stringify({ disposableMysql: true, port, runDirectory: runDir, stopped: true, testExitCode: exitCode }));
}
process.exitCode = exitCode;
