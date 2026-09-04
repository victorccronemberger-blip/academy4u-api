import http from "k6/http";
import { check, sleep } from "k6";
import { loadConfig } from "./config.mjs";

const config = loadConfig(__ENV);
export const options = {
  scenarios: { catalog_read: config.scenario },
  maxRedirects: 0,
  thresholds: {
    http_req_failed: [{ threshold: "rate<0.005", abortOnFail: true, delayAbortEval: "20s" }],
    http_req_duration: ["p(95)<500", "p(99)<1500"],
    checks: ["rate>0.995"],
  },
};

// Only public GETs; never requests payment, shipping, login or customer data.
// This measures HTTP catalog reads, not JS rendering or checkout correctness.
export default function () {
  const response = http.get(`${config.origin}/v1/galatic/catalog/products`, {
    redirects: 0, timeout: "5s", tags: { name: "galatic_catalog" },
    headers: { "User-Agent": "Galatic-Local-Capacity-Audit/1.0" },
  });
  let valid = false;
  try { valid = Array.isArray(response.json().products); } catch { /* counted below */ }
  check(response, {
    "catalog returns 200": (r) => r.status === 200,
    "catalog contract is valid": () => valid,
  });
  sleep(5 + Math.random() * 10);
}
