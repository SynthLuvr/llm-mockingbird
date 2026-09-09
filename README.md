# LLM Mockingbird

A mock implementation of the [Anthropic
API](https://docs.anthropic.com/en/api/getting-started) and the [OpenAI
API](https://platform.openai.com/docs/api-reference) for testing
purposes. Stand in for the real provider APIs in test suites so you can
exercise client code (such as [goose](https://github.com/block/goose))
without network access or API costs.

> **Disclaimer:** This is an unofficial, independent project. It is not
> affiliated with, endorsed by, or sponsored by Anthropic, PBC or
> OpenAI, LLC. “Anthropic” and “Claude” are trademarks of Anthropic,
> PBC; “OpenAI” and “GPT” are trademarks of OpenAI, LLC. This project is
> also not affiliated with goose or its maintainers; it simply targets
> the API surfaces goose calls.

Each provider mock implements the endpoints goose actually calls against
that provider:

- Anthropic — `POST /v1/messages` (streaming chat completions) and
  `GET /v1/models`
- OpenAI — `POST /v1/chat/completions` (streaming and non-streaming) and
  `GET /v1/models`

The two mocks are separate servers: both providers expose
`GET /v1/models`, but the two APIs disagree on that response’s shape, so
they cannot share one app (see
[`docs/decisions/0005-add-openai-provider.md`](./docs/decisions/0005-add-openai-provider.md)).

Responses are **canned** (fixed), which keeps the mocks fast,
deterministic, and dependency-free. Canned text can be supplied inline
or loaded from a markdown file (see `src/responses/` for example
fixtures). For config-driven replies and faults, the [rule
engine](#rule-engine) routes requests past the canned text
declaratively.

## Features

- **Fastify** HTTP servers with the exact routes each provider’s clients
  expect
- **Incremental SSE streaming** for both providers, written straight to
  the socket via `reply.hijack()`, so deltas arrive over time rather
  than in a single burst — just like the real APIs
  - Anthropic: the full event sequence (`message_start` →
    `content_block_start` → `content_block_delta` (one per text chunk) →
    `content_block_stop` → `message_delta` → `message_stop`, terminated
    by `data: [DONE]`) with named `event:` frames
  - OpenAI: `chat.completion.chunk` frames (`data:` lines only) — a role
    chunk, one chunk per text delta, a terminal `finish_reason: "stop"`
    chunk, then `data: [DONE]`
- **OpenAI non-streaming mode** — requests without `"stream": true`
  return a single `chat.completion` JSON body, the OpenAI default
- **Mid-stream error simulation (three modes, both providers)** —
  - `streamErrorAfterMs`: stream deltas for that many milliseconds and
    then tear the socket down mid-flight (no closing frames, no
    `[DONE]`), leaving the client with a truncated, unparsable response
    — exactly as if the real API hit a transport-level `500`-class error
    mid-stream
  - `streamStallAfterMs`: stream deltas, then stall — keep the stream
    open forever with no closing frames and no error, optionally sending
    `: ping` keepalive comments every `streamStallKeepaliveMs`
    milliseconds. Keepalives are legal SSE comment frames: they carry no
    data, so event-driven clients see silence, while byte-level read
    timeouts never fire because bytes keep arriving — a provider that
    streams some content and then wedges behind keepalives
  - `streamSseErrorAfterMs`: stream deltas, then emit a structured SSE
    error frame and end the stream cleanly — a *parseable* mid-stream
    error after the `200` (Anthropic: `event: error` with
    `{"error":{"type":"overloaded_error",...}}`, its only mid-stream
    error channel after a 200 (ADR 0004); OpenAI:
    `data: {"error":{"message":...,"type":"server_error",...}}`). The
    error type and message are configurable. For non-streaming OpenAI
    requests the configured error is returned as an HTTP `500` JSON
    error body after the same delay.
- **`GET /v1/models`** in each provider’s native shape
- **Rule engine** (adapted from npm
  [`llm-mock`](https://www.npmjs.com/package/llm-mock), ADR 0008) —
  route requests by prompt pattern (`{{var}}` capture), provider, model,
  headers, and stream flag; guard on captured variables; step through
  reply sequences; and inject faults (`status` errors with
  provider-shaped bodies and `retry-after`, malformed JSON, bounded
  timeouts, fixed delays) — all declaratively, per rule
- **In-process** testing via Fastify’s `inject()` (no port needed)
- **Standalone** server mode for end-to-end runs and for pointing a real
  client at `ANTHROPIC_HOST` / `OPENAI_HOST`

## Design Decisions

Architecture Decision Records (ADRs) live in
[`docs/decisions/`](./docs/decisions/). Each ADR documents a key design
choice — the rationale, evidence, and alternatives considered — so the
README does not need updating as new decisions are made. Browse the
directory for the full set.

## Prerequisites

- [Node.js](https://nodejs.org) 26 and [pnpm](https://pnpm.io) (enforced
  via `engines`; `.node-version` pins the major for fnm/nvm/asdf)
- [pandoc](https://pandoc.org) 3.10.2 — required by the Markdown
  lint/format steps (CI pins this exact version for consistent GFM
  output); `pnpm exec ts-canon doctor` verifies it
- `bash` on `PATH` — pnpm runs scripts through it (Git for Windows
  provides it)

The lint/format toolchain lives in
[ts-canon](https://github.com/SynthLuvr/ts-canon): one devDependency
that bundles biome, oxlint (+ tsgolint), the ast-grep rules,
convert-to-arrow, jscpd, and the pandoc/peer-deps/audit helpers, and
ships the canonical biome, tsconfig, and vitest presets this repo
extends.

## Quick Start

``` bash
pnpm install
pnpm build           # type-check with tsc
pnpm test            # run integration tests
./bin/llm-mockingbird         # Anthropic mock on http://127.0.0.1:8787
./bin/llm-mockingbird openai  # OpenAI mock on http://127.0.0.1:8788
```

## Usage

### In-process usage

`createAnthropicMock()` / `createOpenAIMock()` return a Fastify instance
with that provider’s routes registered. Use Fastify’s `inject()` to make
requests without binding a port:

``` ts
import { createAnthropicMock, createOpenAIMock } from "llm-mockingbird";

const anthropic = createAnthropicMock();

const response = await anthropic.inject({
  method: "POST",
  url: "/v1/messages",
  payload: { model: "claude-sonnet-4-5", messages: [], stream: true },
});

console.log(response.body); // the canned Anthropic SSE payload
await anthropic.close();

const openai = createOpenAIMock();
const completion = await openai.inject({
  method: "POST",
  url: "/v1/chat/completions",
  payload: { model: "gpt-4o", messages: [] },
});
console.log(completion.json()); // { object: "chat.completion", ... }
await openai.close();
```

### Standalone server (end-to-end)

`startAnthropicMock()` / `startOpenAIMock()` listen on an ephemeral (or
chosen) port and return a `{ url, close }` handle:

``` ts
import { startAnthropicMock, startOpenAIMock } from "llm-mockingbird";

const anthropic = await startAnthropicMock();
console.log(anthropic.url); // http://127.0.0.1:<port>
await anthropic.close();

const openai = await startOpenAIMock();
console.log(openai.url); // http://127.0.0.1:<port>
await openai.close();
```

For a long-running process, use the `llm-mockingbird` launcher. The
provider is chosen by CLI argument or the `LLM_MOCKINGBIRD_PROVIDER`
environment variable (default `anthropic`); `PORT` and `HOST` override
the defaults (`127.0.0.1:8787` for anthropic, `127.0.0.1:8788` for
openai):

``` bash
./bin/llm-mockingbird             # Anthropic on 127.0.0.1:8787
./bin/llm-mockingbird openai      # OpenAI on 127.0.0.1:8788
LLM_MOCKINGBIRD_PROVIDER=openai ./bin/llm-mockingbird
PORT=3000 ./bin/llm-mockingbird openai
LLM_MOCKINGBIRD_CANNED_RESPONSE='canned reply' ./bin/llm-mockingbird
LLM_MOCKINGBIRD_RULES=./rules.json ./bin/llm-mockingbird
LLM_MOCKINGBIRD_LOG=requests.log ./bin/llm-mockingbird
```

`LLM_MOCKINGBIRD_CANNED_RESPONSE` overrides the default canned text,
`LLM_MOCKINGBIRD_RULES` loads the rule engine from a JSON file (see
[Rule engine](#rule-engine)), and `LLM_MOCKINGBIRD_LOG` names a file to
append one `METHOD url` line per request — handy for asserting, from a
test suite, which endpoints a client actually called.

### Consuming as a dependency

The package’s `exports` map points straight at the TypeScript source
(`src/create-mock.ts`), so a consumer needs TypeScript-aware tooling
(`tsx`, `vitest`, …) to import it. It is published to npm as
`llm-mockingbird`:

``` bash
pnpm add -D llm-mockingbird
```

To develop against a local checkout, install it as a link from a sibling
directory instead:

``` bash
pnpm add -D llm-mockingbird@link:../llm-mockingbird
```

The `llm-mockingbird` bin is exposed alongside, so the standalone server
can be spawned from `node_modules/.bin/llm-mockingbird` as well.

### Pointing a client at the mock

Most provider-compatible clients let you override the base host. For
goose, set `ANTHROPIC_HOST` / `OPENAI_HOST` to the mock’s URL:

``` bash
ANTHROPIC_HOST=http://127.0.0.1:8787 ANTHROPIC_API_KEY=test-key goose
OPENAI_HOST=http://127.0.0.1:8788 OPENAI_API_KEY=test-key goose
```

The OpenAI SDKs use `OPENAI_BASE_URL` (or `baseURL`) for the same
purpose.

## API

### `createAnthropicMock(options?): FastifyInstance`

Create a Fastify instance (not yet listening) with the Anthropic routes
(`POST /v1/messages`, `GET /v1/models`) registered. Use `app.inject()`
for testing or `app.listen()` to run it.

### `startAnthropicMock(options?): Promise<RunningMock>`

Create the Anthropic mock and start it listening. Resolves to
`{ url, close }`, where `url` is the base URL
(e.g. `http://127.0.0.1:54321`).

### `createOpenAIMock(options?): FastifyInstance`

Create a Fastify instance (not yet listening) with the OpenAI routes
(`POST /v1/chat/completions`, `GET /v1/models`) registered.

### `startOpenAIMock(options?): Promise<RunningMock>`

Create the OpenAI mock and start it listening. Resolves to
`{ url, close }`.

### Options

One option set — `MockOptions` — configures both provider mocks. Where
defaults differ per provider, both are listed.

| Option | Type | Default | Description |
|----|----|----|----|
| `host` | `string` | `127.0.0.1` | Listen host (`start*` functions only) |
| `port` | `number` | `0` (ephemeral) | Listen port (`0` lets the OS choose) |
| `models` | `readonly string[]` | Anthropic: Sonnet/Opus/Haiku 4.5; OpenAI: `gpt-4o`/`gpt-4o-mini`/`gpt-4.1` | Model ids returned by `GET /v1/models` |
| `cannedResponse` | `string` | Canned greeting | Text split across delta frames |
| `cannedResponseFile` | `string` | — | Path to a file whose contents are the canned text |
| `inputTokens` | `number` | `10` | Prompt/input tokens reported in usage (`usage.input_tokens` / `usage.prompt_tokens`) |
| `outputTokens` | `number` | `1` | Completion tokens reported in usage (`usage.output_tokens` / `usage.completion_tokens`) |
| `streamChunkSize` | `number` | `16` | Characters per streamed text chunk |
| `streamChunkDelayMs` | `number` | `5` | Milliseconds paused between streamed frames |
| `streamErrorAfterMs` | `number` | — | When set, stream deltas this long, then abort the socket mid-flight (truncated, unparsable response) |
| `streamSseErrorAfterMs` | `number` | — | When set, stream deltas this long, then emit a structured SSE error frame and end the stream (OpenAI non-streaming: HTTP `500` error body) |
| `streamSseErrorType` | `string` | Anthropic: `overloaded_error`; OpenAI: `server_error` | The error type inside the mid-stream SSE error frame |
| `streamSseErrorMessage` | `string` | Anthropic: `Overloaded`; OpenAI: `The server had an error…` | The error message inside the mid-stream SSE error frame |
| `streamStallAfterMs` | `number` | — | When set, stream deltas this long, then stall: keep the stream open indefinitely with no closing frames and no error |
| `streamStallKeepaliveMs` | `number` | `500` | How often to emit `: ping` comment lines while stalled; `0` leaves the socket fully silent |
| `rules` | `readonly MockRule[]` | — | Config-driven replies and faults (see [Rule engine](#rule-engine)); first matching rule wins |
| `fallbackResponse` | `string` | — | Reply for requests no rule matches — llm-mock’s `defaults.fallback`; outranks the canned response, which stays the ultimate default |
| `onRequest` | `(request: { method, url }) => void` | — | Observes each request just before its handler runs; the standalone server wires this to `LLM_MOCKINGBIRD_LOG` |

### `RunningMock`

| Field   | Type                  | Description                       |
|---------|-----------------------|-----------------------------------|
| `url`   | `string`              | Base URL of the running mock      |
| `close` | `() => Promise<void>` | Stop the server and free the port |

## Rule engine

`MockOptions.rules` routes completion requests (`POST /v1/messages`,
`POST /v1/chat/completions`) through declarative rules — adapted from
npm `llm-mock` to Fastify/TypeScript/arktype with no new dependencies
(ADR 0008). The first rule whose conditions match supplies the reply (or
the fault); requests no rule matches get `fallbackResponse`, else the
canned response. `GET /v1/models` is never rule-routed.

``` ts
import { createOpenAIMock } from "llm-mockingbird";

const openai = createOpenAIMock({
  fallbackResponse: "Sorry, I don't have a mock for that yet.",
  rules: [
    {
      // Case-insensitive, whitespace-tolerant match against the last user
      // message; {{env}} is captured.
      when: { pattern: "deploy to {{env}}" },
      // Declares the same four guard operators as llm-mock.
      guard: { op: "oneOf", var: "env", values: ["prod", "staging"] },
      reply: "Careful! Deploying to {{env}}",
    },
    { when: { model: "gpt-4.1" }, sequence: ["first", "second", "steady"] },
    { when: { headers: { "X-Canary": "on" } }, ratio: 0.5, status: 429, retryAfterSec: 3 },
    { when: {}, malformedJson: true },
  ],
});
```

### Rule fields

| Field | Type | Description |
|----|----|----|
| `when.pattern` | `string` | `{{var}}` template compiled to a case-insensitive, whitespace-tolerant regex anchored to the whole last user message; captures variables for `reply`/`guard`. Omitted matches any text |
| `when.provider` | `string \| readonly string[]` | Restrict to `"anthropic"` / `"openai"` |
| `when.model` | `string \| readonly string[]` | Restrict to a model id (exact match) |
| `when.headers` | `Record<string, string>` | Every entry must equal the request header of the same (case-insensitive) name |
| `when.stream` | `boolean` | Match only requests whose `stream` flag equals this |
| `guard` | `{ op, var, value?, values? }` | `equals`/`includes`/`oneOf` compare case-insensitively; `matches` is a case-sensitive regex test. A failing guard falls through to later rules |
| `reply` | `string` | The reply text, always `{{var}}`-interpolated |
| `sequence` | `readonly string[]` | Ordered replies across successive matching requests; the last entry repeats. Wins over `reply` when both are set |
| `ratio` | `number` | Probability in \[0, 1\] that an otherwise-matching rule fires; a failed roll falls through without consuming a sequence step |
| `status` | `number` | Any HTTP status, answered with a provider-shaped error body (Anthropic `{"type":"error",…}`, OpenAI `{"error":{…}}`); the error type is mapped from the status |
| `retryAfterSec` | `number` | Sent as `retry-after` alongside `status` |
| `errorType` / `errorMessage` | `string` | Override the mapped error type / default message |
| `malformedJson` | `boolean` | `200` with the truncated body `{"not":"closed"` — valid headers, unparsable payload |
| `timeoutAfterMs` | `number` | Hangs boundedly for this many milliseconds, then destroys the socket (llm-mock’s `TIMEOUT`, adapted so tests terminate) |
| `delayMs` | `number` | Fixed delay before the response — fault or reply |

A matched rule’s reply replaces the canned text: streamed requests carry
it across the usual delta frames, OpenAI non-streaming requests return
it as the `chat.completion` content. Fault outcomes (`status`,
`malformedJson`, `timeoutAfterMs`) answer before any stream starts. A
rule with neither `reply` nor `sequence` and no fault is invalid; a
`delayMs`-only rule delays the fallback reply.

### Rules from a file (standalone server)

The standalone server loads rules from a JSON file — either a bare array
or a `{"rules": [...]}` envelope — named by `LLM_MOCKINGBIRD_RULES`:

``` bash
LLM_MOCKINGBIRD_RULES=./rules.json ./bin/llm-mockingbird anthropic
```

``` json
{
  "rules": [
    {
      "when": { "pattern": "hello {{who}}" },
      "reply": "Hello, {{who}}, from the rules file!"
    },
    { "when": { "stream": true }, "status": 529 }
  ]
}
```

JSON only (no YAML/JS config, ADR 0008). The file is validated at
startup with arktype — unknown fields, bad placeholder names, and rules
without any outcome are rejected with an error naming the file. Library
users pass rules inline, where TypeScript checks them.

## Endpoints

### `POST /v1/messages` (Anthropic)

Accepts a JSON request body (model, messages, system, tools, …). The
mock is lenient: it reads `model` (falling back to `claude-sonnet-4-5`)
and echoes it in the response. It always replies with a canned SSE
stream, splitting the canned text into fixed-width chunks delivered as
one `content_block_delta` each:

    event: message_start
    data: {"type":"message_start","message":{"id":"msg_mock_0001","role":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":1}}}

    event: content_block_start
    data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

    event: content_block_delta
    data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi! This is a can"}}

    event: content_block_delta
    data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ned response from "}}

    ... one content_block_delta per text chunk ...

    event: content_block_stop
    data: {"type":"content_block_stop","index":0}

    event: message_delta
    data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}

    event: message_stop
    data: {"type":"message_stop"}

    data: [DONE]

When `streamErrorAfterMs` is set, the stream instead emits
`message_start`, `content_block_start`, and a run of
`content_block_delta` frames for that many milliseconds, then closes the
connection abruptly — with **none** of the closing frames
(`content_block_stop`, `message_delta`, `message_stop`) or the `[DONE]`
sentinel. The client receives a truncated, unparsable response,
replicating a mid-stream `500`-class server error.

When `streamSseErrorAfterMs` is set instead, the stream emits the same
opening frames and deltas, but then sends a structured `event: error`
SSE frame — the only mid-stream error channel the real API uses after a
`200` (its documented example is `overloaded_error`) — and ends cleanly.
No closing frames or `[DONE]` are sent, because the error is terminal:

    event: error
    data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}

Use `streamSseErrorType` and `streamSseErrorMessage` to customise the
`error.type` and `error.message`. Unlike `streamErrorAfterMs` (an abrupt
transport drop), this delivers a *parseable* error the client can react
to by error type.

When `streamStallAfterMs` is set instead, the stream emits the opening
frames and deltas, then never terminates: no closing frames, no
`[DONE]`, and no error. By default `: ping` comment lines — legal SSE
comment frames every SSE parser ignores — flow every 500ms (configurable
via `streamStallKeepaliveMs`, or `0` for full silence). Bytes keep
arriving, so byte-level read timeouts reset forever, while no event ever
reaches the client: indistinguishable from a model that is merely slow.
This reproduces provider stalls where a request wedges mid-stream and
the client hangs until it is killed.

### `POST /v1/chat/completions` (OpenAI)

Accepts a JSON request body (model, messages, tools, …). The mock is
lenient: it reads `model` (falling back to `gpt-4o`) and echoes it in
the response, and honours the `stream` flag.

With `"stream": true` it replies with a canned SSE stream of
`chat.completion.chunk` frames — `data:` lines only, no `event:` names —
terminated by `data: [DONE]`:

    data: {"id":"chatcmpl-mock-0001","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o","system_fingerprint":"fp_llm_mockingbird_0000","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}

    data: {"id":"chatcmpl-mock-0001","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o","system_fingerprint":"fp_llm_mockingbird_0000","choices":[{"index":0,"delta":{"content":"Hi! This is "},"logprobs":null,"finish_reason":null}]}

    ... one chunk per text chunk ...

    data: {"id":"chatcmpl-mock-0001","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o","system_fingerprint":"fp_llm_mockingbird_0000","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}

    data: [DONE]

Without `stream` (the OpenAI default) it returns a single
`chat.completion` JSON body:

``` json
{
  "id": "chatcmpl-mock-0001",
  "object": "chat.completion",
  "created": 1735689600,
  "model": "gpt-4o",
  "system_fingerprint": "fp_llm_mockingbird_0000",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hi! This is a canned response from llm-mockingbird." },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11 }
}
```

Both mid-stream error modes apply to streaming requests exactly as for
Anthropic: `streamErrorAfterMs` aborts the socket mid-flight (no stop
chunk, no `[DONE]`), while `streamSseErrorAfterMs` emits a parseable
error frame and ends cleanly:

    data: {"error":{"message":"The server had an error while processing your request. Sorry about that!","type":"server_error","param":null,"code":null}}

For non-streaming requests, a configured error mode fails the request
after the same delay with that error object as an HTTP `500` body.

### `GET /v1/models`

Each mock returns the model list in its provider’s native shape.
Anthropic (only `id` is consumed by goose):

``` json
{
  "data": [
    { "id": "claude-sonnet-4-5", "type": "model", "display_name": "claude-sonnet-4-5" },
    { "id": "claude-opus-4-5", "type": "model", "display_name": "claude-opus-4-5" },
    { "id": "claude-haiku-4-5", "type": "model", "display_name": "claude-haiku-4-5" }
  ]
}
```

OpenAI:

``` json
{
  "object": "list",
  "data": [
    { "id": "gpt-4o", "object": "model", "created": 1735689600, "owned_by": "system" },
    { "id": "gpt-4o-mini", "object": "model", "created": 1735689600, "owned_by": "system" },
    { "id": "gpt-4.1", "object": "model", "created": 1735689600, "owned_by": "system" }
  ]
}
```

## Scripts

### Build

| Script       | Description                                         |
|--------------|-----------------------------------------------------|
| `pnpm build` | Type-check the project with `tsc` (no output files) |

### Lint

`pnpm lint` runs `ts-canon lint`, which runs every check in order and
fails fast on the first non-zero step:

1.  Biome check (format + lint + import order)
2.  oxlint with type-aware rules (tsgolint), warnings denied
3.  ast-grep: no inline exports, no function declarations, no leading
    file comments
4.  pandoc: markdown must be GFM-formatted
5.  `pnpm peers check` (skipped without a lockfile)
6.  `pnpm audit --prod` (skipped with `--fast`)
7.  jscpd: code duplication, 5% threshold (skipped with `--fast`)

Both `lint` and `format` accept path arguments, e.g.
`pnpm lint -- src/rules`, and `--fast` skips the slow audit/jscpd steps.

### Format

`pnpm format` runs `ts-canon format`, which runs every formatter in
order (each step’s output is the next step’s input):

1.  `convert-to-arrow` — rewrite `function` declarations to arrow consts
2.  strip single-statement braces (ast-grep)
3.  Biome format
4.  Biome check (lint + format auto-fix)
5.  pandoc — reformat markdown to canonical GFM

### Doctor

`pnpm exec ts-canon doctor` verifies the environment: pandoc (≥ 3.10),
node (≥ 24), pnpm, the bundled tools, and the project-local
`typescript`.

### Test

| Script            | Description                                    |
|-------------------|------------------------------------------------|
| `pnpm test`       | Run integration tests with coverage (80% gate) |
| `pnpm test:watch` | Watch mode (no coverage)                       |

### Canned responses

`src/responses/` holds markdown fixtures used as canned responses.
