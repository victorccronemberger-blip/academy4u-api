// Intentionally local-only: capacity testing requires an isolated environment.
// Do not expose a production API through a local tunnel to bypass this guard.
export function loadConfig(env = {}) {
  const origin = env.LOAD_ORIGIN || "http://127.0.0.1:3000";
  if (!/^http:\/\/(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(origin)) {
    throw new Error("LOAD_ORIGIN must be a local HTTP origin with an explicit port; remote targets are disabled.");
  }
  if (Number(origin.split(":").pop()) > 65535) throw new Error("Invalid port.");
  const profile = env.LOAD_PROFILE || "smoke";
  if (!["smoke", "capacity"].includes(profile)) throw new Error("Unknown LOAD_PROFILE.");
  if (profile === "capacity" && env.CONFIRM_LOCAL_CAPACITY !== "5000") {
    throw new Error("Capacity profile requires CONFIRM_LOCAL_CAPACITY=5000 and isolated local infrastructure.");
  }
  return {
    origin,
    profile,
    scenario: profile === "smoke"
      ? { executor: "constant-vus", vus: 10, duration: "30s", gracefulStop: "10s" }
      : {
          executor: "ramping-vus", startVUs: 0, gracefulRampDown: "30s", gracefulStop: "30s",
          stages: [
            { duration: "2m", target: 100 },
            { duration: "3m", target: 500 },
            { duration: "5m", target: 1000 },
            { duration: "5m", target: 2500 },
            { duration: "5m", target: 5000 },
            { duration: "30m", target: 5000 },
            { duration: "2m", target: 0 },
          ],
        },
  };
}
