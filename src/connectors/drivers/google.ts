import type { Driver } from "../types.js";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const header = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);

function since(range: unknown, fallbackDays = 7): Date {
  const m = /(\d+)\s*d/.exec(String(range ?? ""));
  const days = m ? Number(m[1]) : /month|30/.test(String(range ?? "")) ? 30 : fallbackDays;
  return new Date(Date.now() - days * 86400_000);
}

export const googleDrivers: Record<string, Driver> = {
  "gmail.send": async (i, { call }) => {
    const mime = [`To: ${(i.to as string[]).join(", ")}`, ...(i.cc?.length ? [`Cc: ${(i.cc as string[]).join(", ")}`] : []), `Subject: ${header(String(i.subject))}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", String(i.body)].join("\r\n");
    const r = await call<{ id: string; threadId: string }>("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { body: { raw: b64url(mime) } });
    return { sent: true, id: r.id, threadId: r.threadId };
  },
  "gmail.messages.search": async (i, { call }) => {
    const list = await call<{ messages?: { id: string }[]; resultSizeEstimate?: number }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(Number(i.limit ?? 10), 25)}&q=${encodeURIComponent(String(i.query ?? ""))}`);
    const messages = await Promise.all(
      (list.messages ?? []).map(async (m) => {
        const full = await call<{ snippet: string; payload: { headers: { name: string; value: string }[] } }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        const h = Object.fromEntries(full.payload.headers.map((x) => [x.name.toLowerCase(), x.value]));
        return { id: m.id, from: h.from, subject: h.subject, date: h.date, snippet: full.snippet };
      }),
    );
    return { total: list.resultSizeEstimate ?? messages.length, messages };
  },
  "gcal.events.list": async (i, { call }) => {
    const days = Number(i.days ?? 7);
    const now = new Date();
    const r = await call<{ items: { summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; attendees?: { email: string }[]; location?: string }[] }>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=50&timeMin=${encodeURIComponent(now.toISOString())}&timeMax=${encodeURIComponent(new Date(now.getTime() + days * 86400_000).toISOString())}`,
    );
    return { events: r.items.map((e) => ({ title: e.summary ?? "(no title)", start: e.start.dateTime ?? e.start.date, end: e.end.dateTime ?? e.end.date, attendees: e.attendees?.length ?? 0, location: e.location })) };
  },
  "gdrive.files.search": async (i, { call }) => {
    const q = `fullText contains '${String(i.query ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false`;
    const r = await call<{ files: { id: string; name: string; mimeType: string; webViewLink: string; modifiedTime: string }[] }>(`https://www.googleapis.com/drive/v3/files?pageSize=${Math.min(Number(i.limit ?? 10), 50)}&fields=files(id,name,mimeType,webViewLink,modifiedTime)&q=${encodeURIComponent(q)}`);
    return { files: r.files };
  },
  "gsheets.values.get": async (i, { call }) => {
    const r = await call<{ range: string; values?: string[][] }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(String(i.spreadsheet_id))}/values/${encodeURIComponent(String(i.range ?? "A1:Z200"))}`);
    return { range: r.range, rows: (r.values ?? []).slice(0, 500) };
  },
  "gsheets.values.append": async (i, { call }) => {
    const r = await call<{ updates: { updatedRange: string; updatedRows: number } }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(String(i.spreadsheet_id))}/values/${encodeURIComponent(String(i.range ?? "A1"))}:append?valueInputOption=USER_ENTERED`, { body: { values: i.rows } });
    return { appended: r.updates.updatedRows, range: r.updates.updatedRange };
  },
  "ga4.report": async (i, { call, get }) => {
    const property = String(i.property_id ?? get("propertyId") ?? "");
    if (!property) throw new Error("No GA4 property configured — reconnect Google Analytics with a property ID");
    const start = since(i.range).toISOString().slice(0, 10);
    const totals = await call<{ rows?: { metricValues: { value: string }[] }[] }>(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`, {
      body: { dateRanges: [{ startDate: start, endDate: "today" }], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "conversions" }] },
    });
    const sources = await call<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`, {
      body: { dateRanges: [{ startDate: start, endDate: "today" }], dimensions: [{ name: "sessionSourceMedium" }], metrics: [{ name: "sessions" }], limit: 8, orderBys: [{ metric: { metricName: "sessions" }, desc: true }] },
    });
    const [sessions, users, conversions] = (totals.rows?.[0]?.metricValues ?? []).map((m) => Number(m.value));
    return { since: start, sessions: sessions ?? 0, users: users ?? 0, conversions: conversions ?? 0, conversion_rate: sessions ? Number(((conversions ?? 0) / sessions).toFixed(4)) : 0, top_sources: (sources.rows ?? []).map((r) => ({ source: r.dimensionValues[0].value, sessions: Number(r.metricValues[0].value) })) };
  },
  "outlook.send": async (i, { call }) => {
    await call("https://graph.microsoft.com/v1.0/me/sendMail", { body: { message: { subject: i.subject, body: { contentType: "Text", content: i.body }, toRecipients: (i.to as string[]).map((address) => ({ emailAddress: { address } })) }, saveToSentItems: true } });
    return { sent: true };
  },
  "outlook.messages.search": async (i, { call }) => {
    const r = await call<{ value: { subject: string; from?: { emailAddress: { address: string } }; receivedDateTime: string; bodyPreview: string }[] }>(`https://graph.microsoft.com/v1.0/me/messages?$top=${Math.min(Number(i.limit ?? 10), 25)}&$search=${encodeURIComponent(`"${String(i.query ?? "")}"`)}&$select=subject,from,receivedDateTime,bodyPreview`);
    return { messages: r.value.map((m) => ({ subject: m.subject, from: m.from?.emailAddress.address, date: m.receivedDateTime, snippet: m.bodyPreview })) };
  },
};

export { since };
