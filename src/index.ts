import { DurableObject } from "cloudflare:workers";
import agentDefinition from "../config/agent-definition.json";

export const WORKER_NAME = "open-bulk-invoice-contract-review-agent";
export const MIN_SESSION_AUTH_SECRET_LENGTH = 32;
export const GLOBAL_SESSION_LIMIT = 10;
export const GLOBAL_SESSION_WINDOW_MS = 60_000;
const GLOBAL_SESSION_OBJECT_NAME = "global";

type AgentCreateResponse = {
  id?: string;
  error?: { message?: string };
};

const DEFAULT_INPUT = "Please start a bulk invoice and contract review setup check.\n\nWe have not uploaded the invoice PDFs, contract PDFs, policy document, purchase orders, or payment records yet.\n\nUse live web search only if useful for general review best practices, not to invent our internal policy. Return a concise intake checklist for the missing configuration and documents you need before the review can be completed. Include a recommended report structure, assumptions, risks, and next steps.";

export class GlobalSessionLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS session_window (
          id INTEGER PRIMARY KEY,
          window_start INTEGER NOT NULL,
          count INTEGER NOT NULL
        )
      `);
    });
  }

  allow(): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<{ window_start: number; count: number }>(
        "SELECT window_start, count FROM session_window WHERE id = 1",
      )
      .toArray()[0];

    let windowStart = now;
    let count = 0;
    if (row && now - row.window_start < GLOBAL_SESSION_WINDOW_MS) {
      windowStart = row.window_start;
      count = row.count;
    }

    if (count >= GLOBAL_SESSION_LIMIT) {
      const retryAfterMs = windowStart + GLOBAL_SESSION_WINDOW_MS - now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO session_window (id, window_start, count) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`,
      windowStart,
      count + 1,
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return htmlResponse(renderHome());
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: WORKER_NAME });
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      return createAndStreamSession(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

export function sessionAttemptKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip == null || ip.length === 0) return "ip:unknown";
  return `ip:${ip}`;
}

async function createAndStreamSession(request: Request, env: Env): Promise<Response> {
  const attempt = await env.SESSION_ATTEMPT_LIMITER.limit({ key: sessionAttemptKey(request) });
  if (!attempt.success) {
    logEvent("log", "session attempt limited", { path: "/api/sessions", code: "session_attempt_limited" });
    return jsonResponse(
      { error: "Too many session attempts.", code: "session_attempt_limited" },
      429,
      { "Retry-After": "60" },
    );
  }

  if (!sessionAuthConfigured(env)) {
    logEvent("error", "session auth unavailable", {
      path: "/api/sessions",
      code: "session_auth_unavailable",
    });
    return jsonResponse(
      { error: "Session authentication is unavailable.", code: "session_auth_unavailable" },
      503,
    );
  }

  const provided = bearerToken(request);
  if (provided == null || !(await verifyToken(provided, env.SESSION_AUTH_SECRET))) {
    logEvent("log", "session auth rejected", { path: "/api/sessions", code: "unauthorized" });
    return jsonResponse({ error: "Unauthorized.", code: "unauthorized" }, 401);
  }

  const gate = env.GLOBAL_SESSION_LIMITER.getByName(GLOBAL_SESSION_OBJECT_NAME);
  const decision = await gate.allow();
  if (!decision.allowed) {
    logEvent("log", "global session limit exceeded", { path: "/api/sessions", code: "session_global_limited" });
    return jsonResponse(
      {
        error: "Global session limit exceeded.",
        code: "session_global_limited",
        retry_after_seconds: decision.retryAfterSeconds,
      },
      429,
      { "Retry-After": String(decision.retryAfterSeconds) },
    );
  }

  if (!env.OPENAI_API_KEY) {
    logEvent("error", "openai api key missing", { path: "/api/sessions" });
    return jsonResponse({ error: "OPENAI_API_KEY secret is not configured." }, 500);
  }

  const contentType = request.headers.get("content-type") ?? "";
  let input = DEFAULT_INPUT;

  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { input?: unknown };
    if (typeof body.input === "string" && body.input.trim()) {
      input = body.input.trim();
    }
  } else if (contentType.includes("form")) {
    const formData = await request.formData();
    const value = formData.get("input");
    if (typeof value === "string" && value.trim()) {
      input = value.trim();
    }
  }

  const createAgent = await fetch(`${apiBase(env)}/agents`, {
    method: "POST",
    headers: openAiHeaders(env),
    body: JSON.stringify(agentDefinition),
  });

  if (!createAgent.ok) {
    return openAiError("create reusable agent", createAgent);
  }

  const agent = (await createAgent.json()) as AgentCreateResponse;
  if (!agent.id) {
    return jsonResponse({ error: "Create-agent response did not include an id.", response: agent }, 502);
  }

  const session = await fetch(`${apiBase(env)}/agents/sessions`, {
    method: "POST",
    headers: openAiHeaders(env),
    body: JSON.stringify({
      agent_id: agent.id,
      environment: createEnvironment(env),
      input,
      stream: true,
    }),
  });

  if (!session.ok || !session.body) {
    return openAiError("start streamed session", session);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`event: agent-created\ndata: ${JSON.stringify({ agent_id: agent.id })}\n\n`));

      const reader = session.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `event: worker-error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`,
          ),
        );
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function sessionAuthConfigured(env: Env): boolean {
  return typeof env.SESSION_AUTH_SECRET === "string" && env.SESSION_AUTH_SECRET.length >= MIN_SESSION_AUTH_SECRET_LENGTH;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header == null) return null;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  return header.slice(prefix.length);
}

async function verifyToken(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function apiBase(env: Env): string {
  return (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
}

function createEnvironment(env: Env): { type: string } {
  return { type: env.AGENTS_ENVIRONMENT_TYPE || "openai_hosted" };
}

function openAiHeaders(env: Env): HeadersInit {
  return {
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
    "OpenAI-Beta": "agents=v1",
    ...(env.OPENAI_PROJECT ? { "OpenAI-Project": env.OPENAI_PROJECT } : {}),
    "Content-Type": "application/json",
  };
}

async function openAiError(action: string, response: Response): Promise<Response> {
  const body = await response.text();
  logEvent("error", "openai request failed", { action, status: response.status });
  return jsonResponse(
    {
      error: `Failed to ${action}.`,
      status: response.status,
      body,
    },
    502,
  );
}

function logEvent(level: "log" | "error", message: string, fields: Record<string, string | number>): void {
  const line = JSON.stringify({ message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderHome(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bulk Invoice and Contract Review</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f9;
      color: #171b21;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    header {
      padding: 28px clamp(18px, 4vw, 48px) 14px;
      border-bottom: 1px solid #d8dde6;
      background: #ffffff;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(1.45rem, 3vw, 2.3rem);
      letter-spacing: 0;
    }
    p {
      margin: 0;
      max-width: 760px;
      color: #566070;
      line-height: 1.5;
    }
    main {
      display: grid;
      grid-template-columns: minmax(280px, 520px) minmax(320px, 1fr);
      gap: 24px;
      padding: 24px clamp(18px, 4vw, 48px);
    }
    form, section {
      min-width: 0;
    }
    label {
      display: block;
      font-weight: 650;
      margin-bottom: 10px;
    }
    textarea, input[type="password"] {
      box-sizing: border-box;
      width: 100%;
      padding: 14px;
      border: 1px solid #c9d1dc;
      border-radius: 8px;
      background: #ffffff;
      color: inherit;
      font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    textarea {
      min-height: 430px;
      resize: vertical;
    }
    input[type="password"] {
      min-height: 42px;
      margin-bottom: 12px;
    }
    button {
      margin-top: 12px;
      min-height: 42px;
      padding: 0 16px;
      border: 0;
      border-radius: 8px;
      background: #2057d6;
      color: white;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.65;
      cursor: wait;
    }
    pre {
      box-sizing: border-box;
      min-height: 500px;
      max-height: calc(100vh - 210px);
      overflow: auto;
      margin: 0;
      padding: 14px;
      border: 1px solid #c9d1dc;
      border-radius: 8px;
      background: #111827;
      color: #e8eef8;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    @media (max-width: 860px) {
      main {
        grid-template-columns: 1fr;
      }
      textarea {
        min-height: 320px;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>Bulk Invoice and Contract Review</h1>
    <p>Create a reusable OpenAI Agents API invoice and contract reviewer, start an OpenAI-hosted session from its returned agent ID, and stream raw session events. Session creation requires the operator auth token.</p>
  </header>
  <main>
    <form id="agent-form">
      <label for="auth">Session auth token</label>
      <input id="auth" name="auth" type="password" autocomplete="off" spellcheck="false">
      <label for="input">Initial user message</label>
      <textarea id="input" name="input">${escapeHtml(DEFAULT_INPUT)}</textarea>
      <button id="run" type="submit">Start review session</button>
    </form>
    <section aria-label="Session stream">
      <pre id="output">Waiting to run...</pre>
    </section>
  </main>
  <script>
    const form = document.querySelector("#agent-form");
    const button = document.querySelector("#run");
    const output = document.querySelector("#output");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      output.textContent = "Starting session...\\n";

      try {
        const headers = { "Content-Type": "application/json" };
        if (form.auth.value) headers.Authorization = "Bearer " + form.auth.value;
        const response = await fetch("/api/sessions", {
          method: "POST",
          headers,
          body: JSON.stringify({ input: form.input.value })
        });

        if (!response.ok || !response.body) {
          output.textContent += await response.text();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output.textContent += decoder.decode(value, { stream: true });
          output.scrollTop = output.scrollHeight;
        }
      } catch (error) {
        output.textContent += "\\n" + (error?.message || String(error));
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
