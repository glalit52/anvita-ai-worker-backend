/** Stored (encrypted) per connection. Never returned by the API or shown to the model. */
export interface Credentials {
  kind: "oauth" | "api_key";
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  scope?: string;
  /** API-key style fields entered by the user (tokens, domains, ids). */
  fields?: Record<string, string>;
  /** Provider facts captured at connect time (shop domain, Slack team id, Salesforce instance URL…). */
  extra?: Record<string, string>;
}

export interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  optional?: boolean;
}

export interface OAuthSpec {
  /** Env prefix for client credentials: `${env}_CLIENT_ID` / `${env}_CLIENT_SECRET`. */
  env: string;
  authorizeUrl: (extra: Record<string, string>) => string;
  tokenUrl: (extra: Record<string, string>) => string;
  scopes: string[];
  scopeSeparator?: string;
  /** How the client authenticates at the token endpoint. */
  tokenAuth?: "body" | "basic";
  /** Token request body as JSON instead of form-encoded (Notion, Atlassian). */
  tokenJson?: boolean;
  extraAuthParams?: Record<string, string>;
  /** Fields the user provides before the redirect (e.g. Shopify shop domain, Zendesk subdomain). */
  needs?: FieldSpec[];
  /** Pull provider facts out of the token response (team id, instance URL…). */
  extract?: (token: Record<string, unknown>) => Record<string, string>;
}

export interface AppConnector {
  appId: string;
  oauth?: OAuthSpec;
  apiKey?: { fields: FieldSpec[]; help: string };
  /** Build auth headers for API calls. */
  headers: (c: Credentials) => Record<string, string>;
  /** Cheap authenticated call proving the credentials work; returns a description (and optionally provider facts to keep). */
  test?: (call: Caller) => Promise<string | { detail: string; extra: Record<string, string> }>;
}

/** Authenticated HTTP for one connection (handles refresh, retries, JSON). */
export type Caller = <T = any>(url: string, init?: { method?: string; body?: unknown; form?: Record<string, string>; headers?: Record<string, string>; raw?: string }) => Promise<T>;

export interface DriverContext {
  call: Caller;
  creds: Credentials;
  /** Value of a credential field or connect-time extra (fields win). */
  get: (key: string) => string | undefined;
}

export type Driver = (input: Record<string, any>, ctx: DriverContext) => Promise<Record<string, unknown>>;

export class ConnectorError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}
