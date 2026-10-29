import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getConfig, getSession, authenticatedFetch } from "../auth.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const KEYS = [
  "BCS_URL",
  "BCS_USERNAME",
  "BCS_PASSWORD",
  "BCS_USER_OID",
  "BCS_TOTP_SECRET",
  "BCS_SESSION_ID",
  "BCS_CSRF_TOKEN",
];

function setEnv(env: Record<string, string>): void {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { BCS_URL: "https://bcs.example.com", BCS_USER_OID: "OID1" }, env);
}

describe("SSO (browser cookie) auth", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    setEnv({ BCS_SESSION_ID: "sso-session", BCS_CSRF_TOKEN: "sso-csrf" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("accepts session cookies without username/password", () => {
    const config = getConfig();
    expect(config.BCS_SESSION_ID).toBe("sso-session");
    expect(config.BCS_USERNAME).toBeUndefined();
  });

  it("rejects a half-configured SSO session", () => {
    setEnv({ BCS_SESSION_ID: "only-id" });
    expect(() => getConfig()).toThrow(/BCS_CSRF_TOKEN/);
  });

  it("still requires username/password when no SSO cookies are set", () => {
    setEnv({});
    expect(() => getConfig()).toThrow(/BCS_USERNAME, BCS_PASSWORD/);
  });

  it("getSession returns the configured cookies without any HTTP call", async () => {
    const mockFetch = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", mockFetch);

    const session = await getSession();

    expect(session.sessionId).toBe("sso-session");
    expect(session.csrfToken).toBe("sso-csrf");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("authenticatedFetch sends the SSO cookies and CSRF header", async () => {
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await authenticatedFetch("https://bcs.example.com/bcs/x");

    const headers = new Headers(mockFetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Cookie")).toBe(
      "JSESSIONID=sso-session; CSRF_Token=sso-csrf",
    );
    expect(headers.get("X-CSRF-Token")).toBe("sso-csrf");
  });

  it("throws an actionable error when BCS rejects the SSO session", async () => {
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", mockFetch);

    await expect(authenticatedFetch("https://bcs.example.com/bcs/x")).rejects.toThrow(
      /SSO session expired.*BCS_SESSION_ID/,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
