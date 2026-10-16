import type { FastifyInstance } from "fastify";
import { matchRule } from "../rules/engine";
import { applyFaults } from "../rules/faults";
import type { RuleEngine } from "../rules/types";
import {
  resolveErrorMode,
  resolveFallbackText,
  resolveModel,
  type SseEvent,
  sleep,
  splitText,
  streamReply,
} from "../sse";
import type { MockOptions } from "../types";
import { parseOpenAIRequest } from "./schemas";

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_COMPLETION_ID = "chatcmpl-mock-0001";
// Fixed epoch and fingerprint keep every response byte-for-byte
// deterministic, which the tests assert.
const DEFAULT_CREATED = 1735689600;
const DEFAULT_FINGERPRINT = "fp_llm_mockingbird_0000";
const DEFAULT_INPUT_TOKENS = 10;
const DEFAULT_OUTPUT_TOKENS = 1;
// Token-fragment-sized chunks mirror how the real API streams.
const DEFAULT_CHUNK_SIZE = 16;
// Combined with setNoDelay in beginStream, this delay makes deltas arrive
// over time rather than in a single burst.
const DEFAULT_CHUNK_DELAY_MS = 5;
const DEFAULT_SSE_ERROR_TYPE = "server_error";
const DEFAULT_SSE_ERROR_MESSAGE =
  "The server had an error while processing your request. Sorry about that!";

type ChunkMeta = {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  readonly fingerprint: string;
};

// OpenAI streams `chat.completion.chunk` objects whose only varying parts
// are the delta payload and the finish reason.
const chunkEnvelope = (
  meta: ChunkMeta,
  delta: object,
  finishReason: string | null,
): SseEvent => ({
  data: {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    system_fingerprint: meta.fingerprint,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  },
});

// The first chunk opens the assistant turn; subsequent chunks carry content.
const roleChunk = (meta: ChunkMeta): SseEvent =>
  chunkEnvelope(meta, { role: "assistant", content: "" }, null);

const contentChunk = (meta: ChunkMeta, text: string): SseEvent =>
  chunkEnvelope(meta, { content: text }, null);

// The terminal chunk carries no delta, only the stop signal.
const stopChunk = (meta: ChunkMeta): SseEvent =>
  chunkEnvelope(meta, {}, "stop");

// Reasoning-only chunks for the thinkingOnly fault: reasoning_content
// deltas with no answer content (goose#11975).
const reasoningRoleChunk = (meta: ChunkMeta): SseEvent =>
  chunkEnvelope(meta, { role: "assistant", reasoning_content: "" }, null);

const reasoningChunk = (meta: ChunkMeta, text: string): SseEvent =>
  chunkEnvelope(meta, { reasoning_content: text }, null);

// The structured error object the real API delivers — as a mid-stream
// `data:` frame after a 200, or as the body of an HTTP error response.
const openAIError = (errorType: string, errorMessage: string) => ({
  error: { message: errorMessage, type: errorType, param: null, code: null },
});

const sseErrorEvent = (errorType: string, errorMessage: string): SseEvent => ({
  data: openAIError(errorType, errorMessage),
});

const buildStreamEvents = (
  meta: ChunkMeta,
  chunks: readonly string[],
): readonly SseEvent[] => [
  roleChunk(meta),
  ...chunks.map((text) => contentChunk(meta, text)),
  stopChunk(meta),
];

const buildThinkingOnlyStreamEvents = (
  meta: ChunkMeta,
  chunks: readonly string[],
): readonly SseEvent[] => [
  reasoningRoleChunk(meta),
  ...chunks.map((text) => reasoningChunk(meta, text)),
  stopChunk(meta),
];

const chatCompletionBody = (
  meta: ChunkMeta,
  text: string,
  inputTokens: number,
  outputTokens: number,
) => ({
  id: meta.id,
  object: "chat.completion",
  created: meta.created,
  model: meta.model,
  system_fingerprint: meta.fingerprint,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: text },
      logprobs: null,
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  },
});

// Non-streaming thinking-only completion: the reasoning lands on
// reasoning_content with a null content — the shape DeepSeek-style APIs
// return for a reasoning-only turn (goose#11975).
const thinkingChatCompletionBody = (
  meta: ChunkMeta,
  thinking: string,
  inputTokens: number,
  outputTokens: number,
) => ({
  id: meta.id,
  object: "chat.completion",
  created: meta.created,
  model: meta.model,
  system_fingerprint: meta.fingerprint,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        reasoning_content: thinking,
      },
      logprobs: null,
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  },
});

const registerOpenAIChatCompletionsRoute = (
  app: FastifyInstance,
  options: MockOptions,
  engine: RuleEngine | undefined,
): void => {
  const fallbackText = resolveFallbackText(options);
  const chunkSize = options.streamChunkSize ?? DEFAULT_CHUNK_SIZE;
  const inputTokens = options.inputTokens ?? DEFAULT_INPUT_TOKENS;
  const outputTokens = options.outputTokens ?? DEFAULT_OUTPUT_TOKENS;
  const chunkDelayMs = options.streamChunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS;
  const errorEvent = sseErrorEvent(
    options.streamSseErrorType ?? DEFAULT_SSE_ERROR_TYPE,
    options.streamSseErrorMessage ?? DEFAULT_SSE_ERROR_MESSAGE,
  );
  const errorMode = resolveErrorMode(options);

  app.post("/v1/chat/completions", async (request, reply) => {
    const body = parseOpenAIRequest(request.body);
    const meta: ChunkMeta = {
      id: DEFAULT_COMPLETION_ID,
      created: DEFAULT_CREATED,
      model: resolveModel(body, DEFAULT_MODEL),
      fingerprint: DEFAULT_FINGERPRINT,
    };
    const outcome = matchRule(
      engine,
      "openai",
      request,
      meta.model,
      body.stream === true,
    );
    if (await applyFaults(reply, "openai", outcome)) return;

    // A thinking-only rule streams reasoning deltas with no answer text:
    // the provider half of goose#11975's silent turn end.
    if (outcome?.thinkingOnly !== undefined) {
      const thinkingChunks = splitText(outcome.thinkingOnly, chunkSize);
      if (body.stream) {
        await streamReply(reply, {
          events: buildThinkingOnlyStreamEvents(meta, thinkingChunks),
          opening: [reasoningRoleChunk(meta)],
          deltaEvent: (chunk) => reasoningChunk(meta, chunk),
          errorEvent,
          chunks: thinkingChunks,
          delayMs: chunkDelayMs,
          errorMode,
        });
        return;
      }
      return reply.send(
        thinkingChatCompletionBody(
          meta,
          outcome.thinkingOnly,
          inputTokens,
          outputTokens,
        ),
      );
    }

    // A matched rule's reply replaces the canned text; fault-only rules
    // fall back to it.
    const text = outcome?.reply ?? fallbackText;
    const chunks = splitText(text, chunkSize);

    if (body.stream) {
      await streamReply(reply, {
        events: buildStreamEvents(meta, chunks),
        opening: [roleChunk(meta)],
        deltaEvent: (chunk) => contentChunk(meta, chunk),
        errorEvent,
        chunks,
        delayMs: chunkDelayMs,
        errorMode,
      });
      return;
    }

    // Non-streaming (the OpenAI default): one JSON chat.completion, or the
    // configured error as an HTTP 500 body after the same delay.
    if (errorMode !== undefined) {
      await sleep(errorMode.afterMs);
      return reply.code(500).send(errorEvent.data);
    }
    return reply.send(
      chatCompletionBody(meta, text, inputTokens, outputTokens),
    );
  });
};

export { registerOpenAIChatCompletionsRoute };
