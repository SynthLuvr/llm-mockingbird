import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOpenAIMock } from "../create-mock";
import {
  asText,
  createScratch,
  gooseInstalled,
  gooseOutput,
  runGoose,
  type Scratch,
  startMock,
  teardown,
  writeGooseProfile,
} from "./goose-helpers";

// Only the mock can emit this token, so finding it in goose's output proves
// it reached the mock rather than the live API.
const CANNED_REPLY = "sse-stall-token-d4e5f6";

// Long enough that opening frames and deltas stream before the stall;
// short enough that the test stays fast.
const STALL_AFTER_MS = 1500;

// Keepalive comments must arrive more often than any read timeout a client
// could reasonably configure — each `: ping` line resets the byte-level
// timer while carrying no data, so the client waits forever.
const KEEPALIVE_MS = 500;

// How long goose gets to notice the stall on its own. A client that
// detected the stall would error or retry well inside this window; the
// observed bug hangs indefinitely, so the test kills goose at the deadline.
const GOOSE_WATCH_MS = 20_000;
const TEST_TIMEOUT_MS = 45_000;

// Reproduces a real production stall — the bug reproduces for both OpenAI
// and Anthropic: mid-turn, right after a completed tool round, the next
// completion request hangs — the session stays "working" with no reply,
// no error, and no persisted message until the process is killed and the
// prompt resent. A stream that began normally and then wedged behind
// keepalive comments produces exactly that signature: bytes flow (so no
// read timeout fires) but no event ever arrives (so the request never
// completes and never errors).
describe.skipIf(!gooseInstalled)(
  "goose CLI mid-stream SSE stall (integration)",
  () => {
    let scratch: Scratch;
    let app: FastifyInstance;

    beforeEach(() => {
      scratch = createScratch();
    });

    afterEach(() => teardown(app, scratch));

    it(
      "hangs forever on a stalled stream instead of timing out, erroring, or retrying",
      async () => {
        writeGooseProfile(scratch.configHome, "openai", "gpt-4o");

        // goose fires the main response and a background title-generation
        // request concurrently; only the main one counts.
        let mainRequests = 0;
        app = createOpenAIMock({
          cannedResponse: CANNED_REPLY,
          streamStallAfterMs: STALL_AFTER_MS,
          streamStallKeepaliveMs: KEEPALIVE_MS,
        });
        app.addHook("preHandler", async (request) => {
          if (
            request.method !== "POST" ||
            request.url !== "/v1/chat/completions"
          )
            return;
          const body = (request.body ?? {}) as { messages?: unknown };
          if (!JSON.stringify(body.messages ?? "").includes("title"))
            mainRequests++;
        });

        const url = await startMock(app);

        const result = await runGoose(
          scratch,
          "openai",
          url,
          "Reply with the test token.",
          GOOSE_WATCH_MS,
        );
        const output = gooseOutput(result);

        // CURRENT BEHAVIOUR (bug): goose never notices the stall. It is
        // still waiting on the request when the deadline kills it. A fixed
        // goose would exit on its own — with an error or a retry — before
        // the deadline, making this false.
        expect(
          result.timedOut,
          asText(result.stderr) || asText(result.stdout),
        ).toBe(true);

        // No error was surfaced while waiting: not a stream error, not a
        // timeout, not a retry hint. The process was simply silent.
        expect(output).not.toMatch(/stream decode error/);
        expect(output).not.toMatch(/please resend/);
        expect(output).not.toMatch(/timed? ?out/);
        expect(output).not.toMatch(/overloaded/);
        expect(output).not.toMatch(/rate_limit/);

        // The main request ran exactly once and was never retried: goose
        // is stuck waiting on the first response, not cycling through
        // failures. A fixed goose would retry (> 1) or fail fast.
        expect(mainRequests).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
