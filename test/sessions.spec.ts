import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  GLOBAL_SESSION_LIMIT,
  MIN_SESSION_AUTH_SECRET_LENGTH,
  WORKER_NAME,
  sessionAttemptKey,
} from "../src/session-policy";
import { SESSION_ATTEMPT_LIMIT, TEST_SESSION_AUTH_SECRET } from "./constants";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

let upstreamCalls = 0;

function withSecret(secret: string): Env {
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === "SESSION_AUTH_SECRET") return secret;
      return Reflect.get(target, prop, receiver);
    },
  }) as Env;
}

function sessionRequest(ip: string | null, token: string | null): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (ip !== null) headers.set("CF-Connecting-IP", ip);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return new IncomingRequest("https://example.com/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ input: "Review the uploaded invoices." }),
  });
}

async function post(ip: string | null, token: string | null, targetEnv: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(sessionRequest(ip, token), targetEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

let ipSequence = 0;

function nextIp(): string {
  ipSequence += 1;
  return `203.0.113.${ipSequence}`;
}

describe("session attempt key", () => {
  it("prefixes CF-Connecting-IP and falls back to ip:unknown", () => {
    const present = new IncomingRequest("https://example.com/api/sessions", {
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });
    const missing = new IncomingRequest("https://example.com/api/sessions");
    const empty = new IncomingRequest("https://example.com/api/sessions", {
      headers: { "CF-Connecting-IP": "" },
    });

    expect(sessionAttemptKey(present)).toBe("ip:203.0.113.9");
    expect(sessionAttemptKey(missing)).toBe("ip:unknown");
    expect(sessionAttemptKey(empty)).toBe("ip:unknown");
  });
});

describe("POST /api/sessions", () => {
  beforeEach(async () => {
    await reset();
    upstreamCalls = 0;
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("/v1/agents")) return realFetch(input, init);

      upstreamCalls += 1;
      if (url.includes("/agents/sessions")) {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: test\ndata: {}\n\n"));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({ id: "agent_test" });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 503 when SESSION_AUTH_SECRET is shorter than 32 characters", async () => {
    const short = "s".repeat(MIN_SESSION_AUTH_SECRET_LENGTH - 1);
    const response = await post(nextIp(), TEST_SESSION_AUTH_SECRET, withSecret(short));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code?: string; error?: string };
    expect(body.code).toBe("session_auth_unavailable");
    expect(JSON.stringify(body)).not.toContain(short);
    expect(upstreamCalls).toBe(0);
  });

  it("returns 503 when SESSION_AUTH_SECRET is missing", async () => {
    const response = await post(nextIp(), TEST_SESSION_AUTH_SECRET, withSecret(""));
    expect(response.status).toBe(503);
    expect(upstreamCalls).toBe(0);
  });

  it("returns 401 before calling OpenAI when the bearer token does not match", async () => {
    const missing = await post(nextIp(), null);
    expect(missing.status).toBe(401);
    const wrong = await post(nextIp(), "not-the-session-secret");
    expect(wrong.status).toBe(401);
    const body = (await wrong.json()) as { code?: string };
    expect(body.code).toBe("unauthorized");
    expect(upstreamCalls).toBe(0);
  });

  it("counts attempts before auth and limits one IP", async () => {
    const ip = nextIp();
    for (let attempt = 0; attempt < SESSION_ATTEMPT_LIMIT; attempt += 1) {
      const response = await post(ip, "wrong-token");
      expect(response.status).toBe(401);
    }

    const limited = await post(ip, TEST_SESSION_AUTH_SECRET);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    const body = (await limited.json()) as { code?: string };
    expect(body.code).toBe("session_attempt_limited");
    expect(upstreamCalls).toBe(0);
  });

  it("applies the attempt limiter before the short-secret 503", async () => {
    const ip = nextIp();
    const shortEnv = withSecret("short");
    for (let attempt = 0; attempt < SESSION_ATTEMPT_LIMIT; attempt += 1) {
      const response = await post(ip, null, shortEnv);
      expect(response.status).toBe(503);
    }

    const limited = await post(ip, null, shortEnv);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { code?: string };
    expect(body.code).toBe("session_attempt_limited");
  });

  it("shares ip:unknown for a missing or empty CF-Connecting-IP", async () => {
    for (let attempt = 0; attempt < SESSION_ATTEMPT_LIMIT; attempt += 1) {
      const response = await post(null, "wrong-token");
      expect(response.status).toBe(401);
    }

    const emptyHeader = new IncomingRequest("https://example.com/api/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "",
        "Authorization": "Bearer wrong-token",
      },
      body: JSON.stringify({ input: "hello" }),
    });
    const ctx = createExecutionContext();
    const shared = await worker.fetch(emptyHeader, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(shared.status).toBe(429);

    const other = await post(nextIp(), "wrong-token");
    expect(other.status).toBe(401);
  });

  it("does not share the attempt bucket across IP addresses", async () => {
    const first = nextIp();
    for (let attempt = 0; attempt < SESSION_ATTEMPT_LIMIT; attempt += 1) {
      expect((await post(first, "wrong-token")).status).toBe(401);
    }
    expect((await post(first, "wrong-token")).status).toBe(429);
    expect((await post(nextIp(), "wrong-token")).status).toBe(401);
  });

  it("starts a streamed session when auth and both limits allow it", async () => {
    const response = await post(nextIp(), TEST_SESSION_AUTH_SECRET);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("agent_test");
    expect(upstreamCalls).toBe(2);
  });

  it("caps authorized session creation at 10 per 60 seconds", async () => {
    expect(GLOBAL_SESSION_LIMIT).toBe(10);

    for (let created = 0; created < GLOBAL_SESSION_LIMIT; created += 1) {
      const response = await post(nextIp(), TEST_SESSION_AUTH_SECRET);
      expect(response.status).toBe(200);
      await response.text();
    }

    const callsAfterCap = upstreamCalls;
    const blocked = await post(nextIp(), TEST_SESSION_AUTH_SECRET);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    const body = (await blocked.json()) as { code?: string; retry_after_seconds?: number };
    expect(body.code).toBe("session_global_limited");
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(upstreamCalls).toBe(callsAfterCap);
  });

  it("opens a new global window after 60 seconds", async () => {
    for (let created = 0; created < GLOBAL_SESSION_LIMIT; created += 1) {
      const response = await post(nextIp(), TEST_SESSION_AUTH_SECRET);
      expect(response.status).toBe(200);
      await response.text();
    }
    expect((await post(nextIp(), TEST_SESSION_AUTH_SECRET)).status).toBe(429);

    await runInDurableObject(env.GLOBAL_SESSION_LIMITER.getByName("global"), async (_instance, state) => {
      state.storage.sql.exec("UPDATE session_window SET window_start = ? WHERE id = 1", Date.now() - 61_000);
    });

    const response = await post(nextIp(), TEST_SESSION_AUTH_SECRET);
    expect(response.status).toBe(200);
  });
});

describe("public routes", () => {
  beforeEach(async () => {
    await reset();
  });

  it("names the public worker on the health check", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new IncomingRequest("https://example.com/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; service?: string };
    expect(body).toEqual({ ok: true, service: WORKER_NAME });
    expect(WORKER_NAME).toBe("open-bulk-invoice-contract-review-agent");
  });

  it("serves the home page without a session token", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new IncomingRequest("https://example.com/"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('type="password"');
    expect(html).not.toContain(TEST_SESSION_AUTH_SECRET);
  });

  it("returns 404 for unknown paths", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new IncomingRequest("https://example.com/missing"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });
});
