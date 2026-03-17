# Open-PTC

![Open-PTC](assets/images/Open-PTC.png)

Open-PTC is a unified Deno/TypeScript runtime for programmatic tool calling.

It combines MCP tools, sandboxed code execution, WebSocket callbacks, and an OpenAI-compatible HTTP proxy so an LLM can run multi-step tool workflows with less model round-tripping.

## Why this exists

- Reduce latency in multi-tool tasks by letting code run loops/branching inside a sandbox.
- Reduce context/token load by returning processed results instead of every intermediate tool response.
- Support multiple integration styles (REST, MCP, WebSocket, proxy) with one backend.
- Keep runtime function execution isolated from the model via a tool bridge and a sandbox.

## How it works

Open-PTC starts up to five services:

- **API server** (`9730`): `GET /tree`, `GET /signatures`, `POST /exec`
- **MCP server** (`9731`): exposes Open-PTC as an MCP endpoint
- **RPC server** (`9732`, internal): sandbox ↔ tool bridge communication
- **WebSocket server** (`9733`): register local client tools and handle tool callbacks
- **Proxy server** (`9734`): OpenAI Responses-style endpoint with runtime tool chaining

At runtime:

1. The model requests `code_executor`.
2. Open-PTC runs code in a Deno sandbox with generated tool proxies.
3. If code calls a runtime tool, execution pauses and Open-PTC returns a `function_call` to the client.
4. The client returns `function_call_output`.
5. Open-PTC resumes execution and continues until completion.

## Quick start

### Option A: run directly

```bash
deno run --allow-all src/server.ts
```

Run specific services only:

```bash
deno run --allow-all src/server.ts --api --mcp --ws --proxy
deno run --allow-all src/server.ts --proxy
```

### Option B: run with Docker Compose

1. Create `.env` with your provider keys (for example `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, plus `TAVILY_API_KEY` if using Tavily MCP).
2. Start the stack:

```bash
docker-compose up -d
```

3. Verify core endpoints:

```bash
curl http://localhost:9730/tree
curl http://localhost:9731
curl http://localhost:9734/v1/responses
```

## How to start using it

### 1) Configure tools

- Edit `mcp_config.json` to declare MCP servers.
- `${ENV_VAR}` placeholders are resolved from environment variables.
- Optional `output_schema` entries improve generated signatures and runtime handling.

### 2) Choose an integration mode

- **REST API mode**: inspect tools and execute sandbox code via `/exec`.
- **MCP mode**: connect from any MCP client.
- **WebSocket mode**: register local functions and let sandbox code call back into your app.
- **Proxy mode**: use OpenAI-compatible clients with runtime tools marked by `"open-ptc-runtime-function": true`.

### 3) Run examples

```bash
deno run --allow-all examples/api-client.ts
deno run --allow-all examples/ws-client.ts
deno run --allow-net --allow-env examples/proxy-client.ts
deno run --allow-net --allow-env examples/proxy-sdk-client.ts
deno run --allow-all examples/mcp-client.ts
```

Additional integrations:

- `examples/ai-sdk` (TypeScript + Vercel AI SDK)
- `examples/langgraph` (Python + LangGraph)

## Architecture notes

- `src/server.ts` is the unified entrypoint and default way to run all services.
- `src/mcp/mcp-registry.ts` discovers and groups MCP tools.
- `src/bridge/tool-bridge.ts` handles tool invocation routing.
- `src/execution/sandbox-executor.ts` runs user code in Deno with restricted permissions.
- `src/proxy/sandbox-orchestrator.ts` manages proxy-session chaining and tool-call pauses/resumes.

## Operational details

- Default code execution timeout: `30000` ms (`CODE_EXECUTION_TIMEOUT_MS`).
- WebSocket tool call timeout: `60000` ms.
- Proxy orchestration max chain depth: `10`.
- RPC port (`9732`) is internal and intentionally not exposed by Docker Compose.

## Notes

- `deno.json` includes tasks that reference `mod.ts`; use `src/server.ts` as the current canonical startup path for this repo.
- LiteLLM routing/model selection is configured in `litellm_config.yaml`.