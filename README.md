# Bulk Invoice and Contract Review

Runnable Cloudflare Worker and curl-first example for the OpenAI Agents API. It creates a reusable agent named `Bulk invoice and contract review`, starts a streamed session from the returned `agent_id`, and streams raw session events.

## Files

- `config/agent-definition.json` contains the reusable agent definition.
- `config/session-input.txt` contains the initial user message.
- `scripts/run-agent-session.sh` calls the Agents HTTP API directly with `curl`.
- `src/index.ts` is a Cloudflare Worker UI/API layer that mirrors the same flow.

## Setup

```bash
npm install
export OPENAI_API_KEY="your-api-key"
```

The app uses OpenAI project `proj_mRsQVx3NjOamxeXH6UrLowoC` via the `OpenAI-Project` header by default.

## Run Locally

```bash
npm run run:agent
npm run typecheck
npm run dev
```

## Deploy To Cloudflare Workers

```bash
npx wrangler secret put OPENAI_API_KEY
npm run deploy
```

Default Agents API environment is `openai_hosted`. Set `AGENTS_ENVIRONMENT_TYPE=none` only when no sandbox is needed.
