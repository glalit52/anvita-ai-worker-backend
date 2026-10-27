import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, db } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** migrations/ lives at the repo root both in src (tsx) and dist (compiled) layouts. */
export const migrationsFolder = path.resolve(here, "../../migrations");

export async function runMigrations() {
  await migrate(db, { migrationsFolder });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => console.log("migrations applied"))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
