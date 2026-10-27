import postgres from "postgres";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://anvita:anvita@localhost:5432/anvita_test";
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await sql.end();
  process.env.DATABASE_URL = url;
  const { runMigrations } = await import("../src/db/migrate.js");
  const { closeDb } = await import("../src/db/client.js");
  await runMigrations();
  await closeDb();
}
