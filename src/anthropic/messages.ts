import type { FastifyInstance } from "fastify";
import { matchRule } from "../rules/engine";
import { applyFaults } from "../rules/faults";
import type { RuleEngine } from "../rules/types";
import {
  resolveErrorMode,
  resolveFallbackText,
  resolveModel,
  type SseEvent,
  splitText,
  streamReply,
} from "../sse";
import type { MockOptions } from "../types";
import { parseAnthropicRequest } from "./schemas";

const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_MESSAGE_ID = "msg_mock_0001";
const DEFAULT_INPUT_TOKENS = 10;
const DEFAULT_OUTPUT_TOKENS = 1;
// Token-fragment-sized chunks mirror how the real API streams.
const DEFAULT_CHUNK_SIZE = 16;
// Combined with setNoDelay in beginStream, this delay makes deltas arrive
// over time rather than in a single burst.
const DEFAULT_CHUNK_DELAY_MS = 5;
const DEFAULT_SSE_ERROR_TYPE = "overloaded_error";
const DEFAULT_SSE_ERROR_MESSAGE = "Overloaded";

const textDelta = (text: string): SseEvent => ({
  event: "content_block_delta",
  data: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  },
});

const messageStartEvent = (model: string, inputTokens: number): SseEvent => ({
  event: "message_start",
  data: {
    type: "message_start",
    message: {
      id: DEFAULT_MESSAGE_ID,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // preliminary usage; final counts arrive in message_delta
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  },
});

const contentBlockStartEvent = (): SseEvent => ({
  event: "content_block_start",
  data: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
});

const contentBlockStopEvent = (): SseEvent => ({
  event: "content_block_stop",
  data: { type: "content_block_stop", index: 0 },
});

// Thinking-block frames for the thinkingOnly fault: a signed reasoning
// block with no answer content (goose#11975).
const thinkingBlockStartEvent = (): SseEvent => ({
  event: "content_block_start",
  data: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  },
});

const thinkingDeltaEvent = (text: string): SseEvent => ({
  event: "content_block_delta",
  data: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: text },
  },
});

const signatureDeltaEvent = (signature: string): SseEvent => ({
  event: "content_block_delta",
  data: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature },
  },
});

const messageDeltaEvent = (outputTokens: number): SseEvent => ({
  event: "message_delta",
  data: {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  },
});

const messageStopEvent = (): SseEvent => ({
  event: "message_stop",
  data: { type: "message_stop" },
});

// Channel B: the structured SSE error frame the real API emits mid-stream
// after a 200 — its only mid-stream error channel (ADR 0004).
const sseErrorEvent = (errorType: string, errorMessage: string): SseEvent => ({
  event: "error",
  data: {
    type: "error",
    error: { type: errorType, message: errorMessage },
  },
});

const buildMessageEvents = (
  model: string,
  chunks: readonly string[],
  inputTokens: number,
  outputTokens: number,
): readonly SseEvent[] => [
  messageStartEvent(model, inputTokens),
  contentBlockStartEvent(),
  ...chunks.map(textDelta),
  contentBlockStopEvent(),
  messageDeltaEvent(outputTokens),
  messageStopEvent(),
];

const openingEvents = (
  model: string,
  inputTokens: number,
): readonly SseEvent[] => [
  messageStartEvent(model, inputTokens),
  contentBlockStartEvent(),
];

// Fixed so responses stay byte-for-byte deterministic, like every other
// canned field; goose treats a signed thinking block as content either way.
const MOCK_THINKING_SIGNATURE = "sig_llm_mockingbird_0000";

const thinkingOpeningEvents = (
  model: string,
  inputTokens: number,
): readonly SseEvent[] => [
  messageStartEvent(model, inputTokens),
  thinkingBlockStartEvent(),
];

const buildThinkingOnlyEvents = (
  model: string,
  chunks: readonly string[],
  inputTokens: number,
  outputTokens: number,
): readonly SseEvent[] => [
  messageStartEvent(model, inputTokens),
  thinkingBlockStartEvent(),
  ...chunks.map(thinkingDeltaEvent),
  signatureDeltaEvent(MOCK_THINKING_SIGNATURE),
  contentBlockStopEvent(),
  messageDeltaEvent(outputTokens),
  messageStopEvent(),
];

const registerAnthropicMessagesRoute = (
  app: FastifyInstance,
  options: MockOptions,
  engine: RuleEngine | undefined,
): void => {
  const chunkSize = options.streamChunkSize ?? DEFAULT_CHUNK_SIZE;
  const inputTokens = options.inputTokens ?? DEFAULT_INPUT_TOKENS;
  const outputTokens = options.outputTokens ?? DEFAULT_OUTPUT_TOKENS;
  const chunkDelayMs = options.streamChunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS;
  const fallbackChunks = splitText(resolveFallbackText(options), chunkSize);

  app.post("/v1/messages", async (request, reply) => {
    const body = parseAnthropicRequest(request.body);
    const model = resolveModel(body, DEFAULT_MODEL);
    const outcome = matchRule(
      engine,
      "anthropic",
      request,
      model,
      body.stream === true,
    );
    if (await applyFaults(reply, "anthropic", outcome)) return;

    // A thinking-only rule streams a signed reasoning block and no answer:
    // the provider half of goose#11975's silent turn end.
    if (outcome?.thinkingOnly !== undefined) {
      const thinkingChunks = splitText(outcome.thinkingOnly, chunkSize);
      await streamReply(reply, {
        events: buildThinkingOnlyEvents(
          model,
          thinkingChunks,
          inputTokens,
          outputTokens,
        ),
        opening: thinkingOpeningEvents(model, inputTokens),
        deltaEvent: thinkingDeltaEvent,
        errorEvent: sseErrorEvent(
          options.streamSseErrorType ?? DEFAULT_SSE_ERROR_TYPE,
          options.streamSseErrorMessage ?? DEFAULT_SSE_ERROR_MESSAGE,
        ),
        chunks: thinkingChunks,
        delayMs: chunkDelayMs,
        errorMode: resolveErrorMode(options),
      });
      return;
    }

    // A matched rule's reply replaces the canned chunks; fault-only rules
    // fall back to them.
    const chunks =
      outcome?.reply === undefined
        ? fallbackChunks
        : splitText(outcome.reply, chunkSize);
    await streamReply(reply, {
      events: buildMessageEvents(model, chunks, inputTokens, outputTokens),
      opening: openingEvents(model, inputTokens),
      deltaEvent: textDelta,
      errorEvent: sseErrorEvent(
        options.streamSseErrorType ?? DEFAULT_SSE_ERROR_TYPE,
        options.streamSseErrorMessage ?? DEFAULT_SSE_ERROR_MESSAGE,
      ),
      chunks,
      delayMs: chunkDelayMs,
      errorMode: resolveErrorMode(options),
    });
  });
};

export { registerAnthropicMessagesRoute };
