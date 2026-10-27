import { describe, expect, it } from "vitest";
import { chunkText } from "../src/services/knowledge.js";
import { evaluateCondition, matchesAction, validateCondition } from "../src/runtime/policy.js";
import { cronMatches, parseCron } from "../src/services/workers.js";
import { decrypt, encrypt, hashPassword, verifyPassword } from "../src/lib/crypto.js";

describe("policy conditions", () => {
  const facts = { amount: 6499, recipients: 2, external_recipients: 1, actor: "worker", app: "razorpay", recipient_domains: ["acme.in", "vc.in"] };
  it.each([
    ["always", true],
    ["never", false],
    ["amount > 5000", true],
    ["amount <= 5000", false],
    ["external_recipients > 0 and actor == worker", true],
    ["actor is agent", false],
    ["actor is not agent", true],
    ["app in [razorpay, stripe]", true],
    ["app not in [razorpay]", false],
    ["recipient_domains contains vc.in", true],
    ["not (amount > 5000) or recipients >= 2", true],
    ['actor == "worker" and (amount > 10000 or recipients > 1)', true],
    ["missing_fact > 3", false],
  ])("%s → %s", (expr, expected) => expect(evaluateCondition(expr, facts)).toBe(expected));

  it("rejects malformed conditions", () => {
    expect(validateCondition("amount >")).toBeTruthy();
    expect(validateCondition("(amount > 5")).toBeTruthy();
    expect(validateCondition("amount > 5 and")).toBeTruthy();
    expect(validateCondition("amount > 5000")).toBeNull();
  });

  it("matches action globs", () => {
    expect(matchesAction("gmail.send, outlook.send", "gmail.send")).toBe(true);
    expect(matchesAction("*.delete", "hubspot.contacts.delete")).toBe(true);
    expect(matchesAction("hubspot.*.update", "hubspot.deals.update")).toBe(true);
    expect(matchesAction("hubspot.*.update", "hubspot.deals.search")).toBe(false);
    expect(matchesAction("*", "anything.at.all")).toBe(true);
    expect(matchesAction("email.send · gmail", "gmail")).toBe(true);
  });
});

describe("cron", () => {
  it("parses and matches", () => {
    const mon0300 = new Date("2026-10-26T03:30:00Z"); // Monday
    expect(cronMatches("30 3 * * 1", mon0300)).toBe(true);
    expect(cronMatches("30 3 * * MON", mon0300)).toBe(true);
    expect(cronMatches("30 3 * * 2", mon0300)).toBe(false);
    expect(cronMatches("*/15 * * * *", mon0300)).toBe(true);
    expect(cronMatches("0 9 1 * *", new Date("2026-11-01T09:00:00Z"))).toBe(true);
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * *")).toThrow();
  });
});

describe("crypto", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("s3cret-password");
    expect(await verifyPassword("s3cret-password", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("round-trips encryption and detects tampering", () => {
    const c = encrypt('{"botToken":"xoxb-1"}');
    expect(decrypt(c)).toBe('{"botToken":"xoxb-1"}');
    const parts = c.split(".");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("A") ? "BB" : "AA");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
});

describe("chunking", () => {
  it("packs paragraphs and splits long ones", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"lorem ipsum ".repeat(30)}`).join("\n\n");
    const chunks = chunkText(text, 1000, 100);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunkText("x".repeat(5000), 1000, 100).length).toBeGreaterThanOrEqual(5);
  });
});
