import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";

import type { FastifyReply } from "fastify";

import type { MockOptions } from "./types";

const DEFAULT_RESPONSE = "Hi! This is a canned response from llm-mockingbird.";

// Keepalives frequent enough to defeat any realistic read timeout while
// staying far below any rate limit.
const DEFAULT_STALL_KEEPALIVE_MS = 500;

// Anthropic frames name their event (`event:` + `data:` lines); OpenAI
// frames carry `data:` lines only, so one serializer serves both wire
// formats.
type SseEvent = {
  readonly event?: string;
  readonly data: object;
};

// How a stream fails once its error duration elapses: `transport` tears the
// socket down mid-flight (no closing frames); `sse` emits the error frame
// and ends the stream cleanly; `stall` never terminates the stream at all.
type ErrorMode =
  | { readonly kind: "transport"; readonly afterMs: number }
  | { readonly kind: "sse"; readonly afterMs: number }
  | {
      readonly kind: "stall";
      readonly afterMs: number;
      readonly keepaliveMs: number;
    };

// Everything streamReply needs to serve one endpoint: the frames of a
// successful stream, plus the opening frames and delta shape the error
// modes reuse before terminating.
type StreamPlan = {
  readonly events: readonly SseEvent[];
  readonly opening: readonly SseEvent[];
  readonly deltaEvent: (text: string) => SseEvent;
  readonly errorEvent: SseEvent;
  readonly chunks: readonly string[];
  readonly delayMs: number;
  readonly errorMode?: ErrorMode;
};

const serializeEvent = (event: SseEvent): string =>
  event.event === undefined
    ? `data: ${JSON.stringify(event.data)}\n\n`
    : `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const resolveModel = (
  body: { readonly model?: string },
  fallback: string,
): string =>
  typeof body.model === "string" && body.model.length > 0
    ? body.model
    : fallback;

// Fixed-width runs: concatenating the deltas reproduces the text exactly.
const splitText = (text: string, size: number): readonly string[] => {
  if (size <= 0 || text.length === 0) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size)
    chunks.push(text.slice(i, i + size));
  return chunks;
};

// fallbackResponse (llm-mock's defaults.fallback) outranks the canned
// text, which stays the ultimate default (ADR 0008).
const resolveFallbackText = (options: MockOptions): string => {
  if (options.fallbackResponse !== undefined) return options.fallbackResponse;
  if (options.cannedResponseFile)
    return readFileSync(resolve(options.cannedResponseFile), "utf8");
  return options.cannedResponse ?? DEFAULT_RESPONSE;
};

// Each fault duration arms its mode only when positive; 0 disables it.
const isArmed = (ms: number | undefined): ms is number =>
  ms !== undefined && ms > 0;

// The stall mode wins when several are configured: it is the most
// specific — a stream that never terminates can never reach the other
// terminations. Next comes the SSE error frame, then the transport abort.
const resolveErrorMode = (options: MockOptions): ErrorMode | undefined => {
  const { streamErrorAfterMs, streamSseErrorAfterMs, streamStallAfterMs } =
    options;
  if (isArmed(streamStallAfterMs))
    return {
      kind: "stall",
      afterMs: streamStallAfterMs,
      keepaliveMs: options.streamStallKeepaliveMs ?? DEFAULT_STALL_KEEPALIVE_MS,
    };
  if (isArmed(streamSseErrorAfterMs))
    return { kind: "sse", afterMs: streamSseErrorAfterMs };
  if (isArmed(streamErrorAfterMs))
    return { kind: "transport", afterMs: streamErrorAfterMs };
  return undefined;
};

// Honours backpressure: if the socket buffer fills, wait for drain before
// the next frame so a long error-mode stream can't exhaust memory.
const writeFrame = async (
  raw: ServerResponse,
  event: SseEvent,
  delayMs: number,
): Promise<void> => {
  if (!raw.write(serializeEvent(event))) await once(raw, "drain");
  await sleep(delayMs);
};

// reply.hijack() bypasses Fastify's serialization, so each write() is
// flushed to the wire on its own schedule instead of buffering into one
// reply body. Nagle is disabled so small frames are pushed out immediately
// rather than coalesced into a single burst.
const beginStream = (raw: ServerResponse): void => {
  raw.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream",
  });
  raw.socket?.setNoDelay(true);
};

const streamEvents = async (
  raw: ServerResponse,
  events: readonly SseEvent[],
  delayMs: number,
): Promise<void> => {
  beginStream(raw);
  for (const event of events) await writeFrame(raw, event, delayMs);
  raw.end("data: [DONE]\n\n");
};

// Writes the opening frames, then cycles the deltas until `durationMs`
// elapses — the shared body of every error mode, which differ only in
// how they terminate.
const streamOpeningThenDeltas = async (
  raw: ServerResponse,
  plan: StreamPlan,
  durationMs: number,
): Promise<void> => {
  beginStream(raw);
  for (const event of plan.opening) await writeFrame(raw, event, plan.delayMs);
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline)
    for (const chunk of plan.chunks) {
      await writeFrame(raw, plan.deltaEvent(chunk), plan.delayMs);
      if (Date.now() >= deadline) break;
    }
};

// Holds the stream open with nothing but keepalive comment lines — a
// provider that wedged after streaming some content. The comment frames
// defeat byte-level read timeouts while every SSE parser ignores them, so
// the client sees silence on a healthy connection. Ends only when the
// client gives up and disconnects, which flips `writable` off.
const stallForever = async (
  raw: ServerResponse,
  keepaliveMs: number,
): Promise<void> => {
  if (keepaliveMs <= 0) {
    await once(raw, "close");
    return;
  }
  while (raw.writable) {
    raw.write(": ping\n\n");
    await sleep(keepaliveMs);
  }
};

const streamByMode = async (
  raw: ServerResponse,
  plan: StreamPlan,
): Promise<void> => {
  const { errorMode } = plan;
  if (errorMode === undefined) {
    await streamEvents(raw, plan.events, plan.delayMs);
    return;
  }
  await streamOpeningThenDeltas(raw, plan, errorMode.afterMs);
  if (errorMode.kind === "transport") raw.destroy();
  else if (errorMode.kind === "sse") {
    await writeFrame(raw, plan.errorEvent, plan.delayMs);
    raw.end();
  } else await stallForever(raw, errorMode.keepaliveMs);
};

// Hijacks the reply and streams `plan.events` to completion, or — when an
// error mode is configured — the opening frames and deltas for the
// configured duration followed by that mode's termination (or, for the
// stall mode, by no termination at all).
const streamReply = async (
  reply: FastifyReply,
  plan: StreamPlan,
): Promise<void> => {
  reply.hijack();
  try {
    await streamByMode(reply.raw, plan);
  } catch {
    // Hijacked replies have no error path; tear the socket down.
    reply.raw.destroy();
  }
};

export type { SseEvent };
export {
  resolveErrorMode,
  resolveFallbackText,
  resolveModel,
  sleep,
  splitText,
  streamReply,
};
