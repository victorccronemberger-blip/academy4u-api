export function createHealthRouter(
  express,
  environment,
  readiness = { status: "ready", error: null },
  waitForReady = async () => {},
) {
  const router = express.Router();

  router.get("/", async (_request, response) => {
    await waitForReady();
    const available = readiness.status === "ready";
    response.status(available ? 200 : 503).json({
      status: available ? "ok" : readiness.status,
      service: "academy-api",
      database: {
        status: readiness.status,
        error: readiness.error,
      },
      capabilities: {
        checkout: available && environment.checkoutEnabled,
      },
    });
  });

  return router;
}
