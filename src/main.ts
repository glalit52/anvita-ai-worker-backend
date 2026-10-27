import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { registerJobHandlers, schedulerTick } from "./jobs/handlers.js";
import { JobRunner } from "./jobs/queue.js";
import { ensureListening } from "./services/events.js";

async function main() {
  const app = await buildApp();
  const log = app.log;
  if (process.env.MIGRATE_ON_START !== "false") await runMigrations();

  let runner: JobRunner | null = null;
  let scheduler: NodeJS.Timeout | null = null;
  if (config.ROLE !== "api") {
    registerJobHandlers();
    runner = new JobRunner(log.child({ component: "jobs" }));
    await runner.start();
    if (config.SCHEDULER_ENABLED) {
      const tick = () => schedulerTick(log.child({ component: "scheduler" })).catch((err) => log.error({ err }, "scheduler tick failed"));
      // Align to the start of each minute.
      setTimeout(() => {
        void tick();
        scheduler = setInterval(tick, 60_000);
      }, 60_000 - (Date.now() % 60_000) + 500);
    }
  }
  if (config.ROLE !== "worker") {
    await ensureListening();
    await app.listen({ host: config.HOST, port: config.PORT });
  }
  log.info({ role: config.ROLE, env: config.NODE_ENV }, "anvita backend started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    if (scheduler) clearInterval(scheduler);
    await app.close(); // stop accepting requests, finish in-flight ones
    await runner?.stop();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
