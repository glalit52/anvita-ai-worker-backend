import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;
/** A db handle or an open transaction — services accept either. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

export const sqlClient = postgres(config.DATABASE_URL, {
  max: config.DATABASE_POOL_MAX,
  onnotice: () => {},
  connection: { application_name: `anvita-${config.ROLE}` },
});

export const db: Db = drizzle(sqlClient, { schema });

export async function closeDb() {
  await sqlClient.end({ timeout: 5 });
}
