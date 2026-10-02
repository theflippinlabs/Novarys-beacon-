import { describe, expect, it } from "vitest";
import { normalizeServiceAccountJson, parseServiceAccount } from "@/integrations/google-auth";

const key = JSON.stringify({ type: "service_account", client_email: "beacon@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n", token_uri: "https://oauth2.googleapis.com/token" }, null, 2);

describe("pasted service account JSON", () => {
  it("accepts the file as is", () => {
    expect(parseServiceAccount(key).client_email).toBe("beacon@p.iam.gserviceaccount.com");
  });

  it("repairs typographic quotes, invisible characters and surrounding text from a phone paste", () => {
    const pasted = `﻿Here is my key: ${key.replace(/"/g, (_, i: number) => (i % 2 ? "”" : "“")).replace(/ {2}/g, "  ")}​ thanks`;
    const sa = parseServiceAccount(pasted);
    expect(sa.client_email).toBe("beacon@p.iam.gserviceaccount.com");
    expect(sa.private_key.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
    expect(normalizeServiceAccountJson(pasted)).toBe(key);
  });

  it("still rejects text that is not a key", () => {
    expect(() => parseServiceAccount("not json")).toThrow("Service account JSON is invalid");
    expect(() => parseServiceAccount('{"type":"service_account"}')).toThrow("client_email and private_key");
  });
});
