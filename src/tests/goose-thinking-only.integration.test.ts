import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAnthropicMock, createOpenAIMock } from "../create-mock";
import type { MockRule } from "../rules/types";
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

// Only the mock can emit these tokens, so finding either in goose's output
// proves the reply came from the mock rather than the live API.
const CANNED_REPLY = "thinking-only-fallback-token-f7a8b9";
const THINKING_TEXT = "Let me work through this step by step.";

// The reasoning-only response that reproduces goose#11975: the model
// streams a (signed) thinking block, then the stream ends normally —
// no answer text, no tool call.
//
// `when: {}` targets every completion request, like the stall mode: goose
// appends a <turn-context> block to the user message and folds the prompt
// into the title-generation request, so a pattern anchored to the raw
// prompt text does not match reliably.
const THINKING_ONLY_RULE: MockRule = {
  when: {},
  thinkingOnly: THINKING_TEXT,
};

// Reproduces goose#11975: when the only content of a provider response is a
// thinking block, goose treats the turn as productive and exits in silence —
// exit code 0, no answer rendered, no error, and no retry attempted. Both
// wire shapes reproduce it: the OpenAI reasoning_content form (the issue's
// original report) and the Anthropic signed thinking block (the field
// report from z.ai's Anthropic-compatible API).
describe.skipIf(!gooseInstalled)(
  "goose CLI thinking-only turn (integration)",
  () => {
    let scratch: Scratch;
    let app: FastifyInstance;

    beforeEach(() => {
      scratch = createScratch();
    });

    afterEach(() => teardown(app, scratch));

    it("ends the turn silently on an openai reasoning-only response", async () => {
      writeGooseProfile(scratch.configHome, "openai", "gpt-4o");

      // goose fires the main response and a background title-generation
      // request concurrently; only the main one counts.
      let mainRequests = 0;
      app = createOpenAIMock({
        cannedResponse: CANNED_REPLY,
        rules: [THINKING_ONLY_RULE],
      });
      app.addHook("preHandler", async (request) => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions")
          return;
        const body = (request.body ?? {}) as { messages?: unknown };
        if (
          !JSON.stringify(body.messages ?? "").includes(
            "Generate a short title",
          )
        )
          mainRequests++;
      });

      const url = await startMock(app);

      const result = await runGoose(
        scratch,
        "openai",
        url,
        "Reply with the test token.",
      );
      const output = gooseOutput(result);

      // CURRENT BEHAVIOUR (bug): goose exits 0 having printed nothing —
      // no answer, no error, no retry hint. A fixed goose would either
      // answer, surface the empty turn, or retry (mainRequests > 1).
      expect(
        result.exitCode,
        asText(result.stderr) || asText(result.stdout),
      ).toBe(0);
      expect(output).not.toContain(THINKING_TEXT.toLowerCase());
      expect(output).not.toContain(CANNED_REPLY.toLowerCase());
      expect(output).not.toMatch(/empty response/);
      expect(output).not.toMatch(/please resend/);
      expect(mainRequests).toBe(1);
    }, 45_000);

    it("ends the turn silently on an anthropic signed thinking-only response", async () => {
      writeGooseProfile(scratch.configHome, "anthropic", "claude-sonnet-4-5");

      let mainRequests = 0;
      app = createAnthropicMock({
        cannedResponse: CANNED_REPLY,
        rules: [THINKING_ONLY_RULE],
      });
      app.addHook("preHandler", async (request) => {
        if (request.method !== "POST" || request.url !== "/v1/messages") return;
        const body = (request.body ?? {}) as { system?: unknown };
        const text =
          typeof body.system === "string"
            ? body.system
            : JSON.stringify(body.system ?? "");
        if (!text.includes("Generate a short title")) mainRequests++;
      });

      const url = await startMock(app);

      const result = await runGoose(
        scratch,
        "anthropic",
        url,
        "Reply with the test token.",
      );
      const output = gooseOutput(result);

      // CURRENT BEHAVIOUR (bug): same silent exit on the Anthropic wire
      // shape, where the thinking block carries a signature — the shape
      // goose's guard treats as productive content.
      expect(
        result.exitCode,
        asText(result.stderr) || asText(result.stdout),
      ).toBe(0);
      expect(output).not.toContain(THINKING_TEXT.toLowerCase());
      expect(output).not.toContain(CANNED_REPLY.toLowerCase());
      expect(output).not.toMatch(/empty response/);
      expect(output).not.toMatch(/please resend/);
      expect(mainRequests).toBe(1);
    }, 45_000);
  },
);
