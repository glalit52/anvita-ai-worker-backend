import type { AppDef, Template } from "../contracts/web.js";
import { apps as appList } from "../db/seed-data/apps.js";
import { templates as templateList } from "../db/seed-data/workers.js";

/** The integration catalog and Worker templates are product data shared by every workspace. */
export const apps: AppDef[] = appList;
export const appById = Object.fromEntries(apps.map((a) => [a.id, a])) as Record<string, AppDef>;
export const templates: Template[] = templateList;
export const templateById = Object.fromEntries(templates.map((t) => [t.id, t])) as Record<string, Template>;

/** Apps that are always available without a user connection. */
export const SYSTEM_APPS = new Set(["web", "sandbox", "anvita"]);
