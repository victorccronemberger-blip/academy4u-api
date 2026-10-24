import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const findings = [];
const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["asaas-live-key", /\$aact_(?:prod|hmlg)_[A-Za-z0-9:_-]{24,}/],
  ["google-api-key", /AIza[0-9A-Za-z_-]{30,}/],
  ["generic-live-secret", /\b(?:sk|pk)_(?:live|prod)_[0-9A-Za-z]{20,}\b/],
  ["credentialed-remote-dsn", /mysql:\/\/[^\s:'"/]+:[^\s@'"/]{12,}@(?!(?:127\.0\.0\.1|localhost)\b)[^\s'"/]+/i],
];

for (const file of files) {
  if (file === "package-lock.json" || /\.(?:png|jpe?g|webp|ico|woff2?|pdf|zip)$/i.test(file)) continue;
  let source;
  try { source = readFileSync(file, "utf8"); } catch { continue; }
  for (const [rule, pattern] of rules) {
    if (pattern.test(source)) findings.push({ file, rule });
  }
}

if (findings.length) {
  console.error("Potential committed secrets detected:");
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.rule}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed (${files.length} source files inspected).`);
}
