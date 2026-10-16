import { describe, expect, it } from "vitest";

import { createRuleEngine } from "../../rules/engine";
import type { MockRule, RuleRequestContext } from "../../rules/types";

const context = (
  overrides: Partial<RuleRequestContext> = {},
): RuleRequestContext => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  text: "hello",
  headers: {},
  stream: true,
  ...overrides,
});

describe("createRuleEngine (unit)", () => {
  it("returns undefined without rules", () => {
    expect(createRuleEngine(undefined)).toBeUndefined();
    expect(createRuleEngine([])).toBeUndefined();
  });

  it("matches by pattern and interpolates the captured vars", () => {
    const engine = createRuleEngine([
      { when: { pattern: "my name is {{name}}" }, reply: "Hi {{name}}" },
    ])!;
    expect(engine.match(context({ text: "My name is Ada" }))).toMatchObject({
      reply: "Hi Ada",
    });
  });

  it("returns undefined when no rule matches", () => {
    const engine = createRuleEngine([
      { when: { pattern: "goodbye" }, reply: "bye" },
    ])!;
    expect(engine.match(context())).toBeUndefined();
  });

  it("returns the first matching rule", () => {
    const engine = createRuleEngine([
      { when: { pattern: "hello" }, reply: "first" },
      { when: { pattern: "hello" }, reply: "second" },
    ])!;
    expect(engine.match(context())!.reply).toBe("first");
  });

  it("matches any text when no pattern is set", () => {
    const engine = createRuleEngine([{ when: {}, reply: "catch all" }])!;
    expect(engine.match(context({ text: "anything at all" }))!.reply).toBe(
      "catch all",
    );
  });

  it("filters by provider, as a string or list", () => {
    const engine = createRuleEngine([
      { when: { provider: "openai" }, reply: "openai only" },
    ])!;
    expect(engine.match(context({ provider: "anthropic" }))).toBeUndefined();
    expect(engine.match(context({ provider: "openai" }))!.reply).toBe(
      "openai only",
    );

    const list = createRuleEngine([
      { when: { provider: ["openai", "anthropic"] }, reply: "both" },
    ])!;
    expect(list.match(context({ provider: "anthropic" }))!.reply).toBe("both");
  });

  it("filters by model, as a string or list", () => {
    const engine = createRuleEngine([
      { when: { model: ["gpt-4o", "gpt-4.1"] }, reply: "chosen" },
    ])!;
    expect(engine.match(context({ model: "gpt-4o" }))!.reply).toBe("chosen");
    expect(engine.match(context({ model: "gpt-3.5" }))).toBeUndefined();
  });

  it("matches headers case-insensitively by name and falls through on mismatch", () => {
    const engine = createRuleEngine([
      { when: { headers: { "X-Test": "a" } }, reply: "headered" },
      { when: {}, reply: "catch all" },
    ])!;
    expect(engine.match(context({ headers: { "x-test": "a" } }))!.reply).toBe(
      "headered",
    );
    expect(engine.match(context({ headers: { "x-test": "b" } }))!.reply).toBe(
      "catch all",
    );
  });

  it("matches repeated headers when any member equals the value", () => {
    const engine = createRuleEngine([
      { when: { headers: { accept: "text/plain" } }, reply: "plain" },
    ])!;
    expect(
      engine.match(
        context({ headers: { accept: ["text/html", "text/plain"] } }),
      )?.reply,
    ).toBe("plain");
  });

  it("filters by stream flag", () => {
    const engine = createRuleEngine([
      { when: { stream: false }, reply: "not streaming" },
    ])!;
    expect(engine.match(context({ stream: true }))).toBeUndefined();
    expect(engine.match(context({ stream: false }))!.reply).toBe(
      "not streaming",
    );
  });
});

describe("guard (unit)", () => {
  const patternRule = (guard: MockRule["guard"], reply: string): MockRule => ({
    when: { pattern: "deploy to {{env}}" },
    guard,
    reply,
  });

  it("equals compares case-insensitively", () => {
    const engine = createRuleEngine([
      patternRule({ op: "equals", var: "env", value: "Prod" }, "guarded"),
    ])!;
    expect(engine.match(context({ text: "deploy to prod" }))!.reply).toBe(
      "guarded",
    );
    expect(
      engine.match(context({ text: "deploy to staging" })),
    ).toBeUndefined();
  });

  it("includes matches substrings case-insensitively", () => {
    const engine = createRuleEngine([
      patternRule({ op: "includes", var: "env", value: "PROD" }, "guarded"),
    ])!;
    expect(engine.match(context({ text: "deploy to eu-prod-3" }))!.reply).toBe(
      "guarded",
    );
  });

  it("oneOf matches any listed value", () => {
    const engine = createRuleEngine([
      patternRule(
        { op: "oneOf", var: "env", values: ["prod", "staging"] },
        "guarded",
      ),
    ])!;
    expect(engine.match(context({ text: "deploy to Staging" }))!.reply).toBe(
      "guarded",
    );
    expect(engine.match(context({ text: "deploy to dev" }))).toBeUndefined();
  });

  it("matches tests a case-sensitive regex", () => {
    const engine = createRuleEngine([
      patternRule({ op: "matches", var: "env", value: "^prod-\\d+$" }, "ok"),
    ])!;
    expect(engine.match(context({ text: "deploy to prod-42" }))!.reply).toBe(
      "ok",
    );
    expect(
      engine.match(context({ text: "deploy to PROD-42" })),
    ).toBeUndefined();
  });

  it("a failing guard falls through to later rules", () => {
    const engine = createRuleEngine([
      patternRule({ op: "equals", var: "env", value: "prod" }, "nope"),
      { when: { pattern: "deploy to {{env}}" }, reply: "default deploy" },
    ])!;
    expect(engine.match(context({ text: "deploy to dev" }))!.reply).toBe(
      "default deploy",
    );
  });

  it("guards a missing variable against the empty string", () => {
    const engine = createRuleEngine([
      patternRule({ op: "equals", var: "missing", value: "" }, "empty ok"),
    ])!;
    expect(engine.match(context({ text: "deploy to prod" }))!.reply).toBe(
      "empty ok",
    );
  });
});

describe("sequence and ratio (unit)", () => {
  it("walks a sequence across matches and repeats the last entry", () => {
    const engine = createRuleEngine([
      { when: { pattern: "hello" }, sequence: ["one", "two", "three"] },
    ])!;
    const replies = [1, 2, 3, 4, 5].map(() => engine.match(context())!.reply);
    expect(replies).toEqual(["one", "two", "three", "three", "three"]);
  });

  it("a sequence wins over a reply on the same rule", () => {
    const engine = createRuleEngine([
      { when: { pattern: "hello" }, reply: "ignored", sequence: ["a", "b"] },
    ])!;
    expect(engine.match(context())!.reply).toBe("a");
    expect(engine.match(context())!.reply).toBe("b");
  });

  it("ratio 0 never fires", () => {
    const engine = createRuleEngine([{ when: {}, ratio: 0, reply: "never" }])!;
    for (let i = 0; i < 50; i += 1)
      expect(engine.match(context())).toBeUndefined();
  });

  it("ratio 1 always fires", () => {
    const engine = createRuleEngine([{ when: {}, ratio: 1, reply: "always" }])!;
    for (let i = 0; i < 50; i += 1)
      expect(engine.match(context())!.reply).toBe("always");
  });

  it("a ratio below 1 falls through to later rules when the roll fails", () => {
    const engine = createRuleEngine([
      { when: {}, ratio: 0.5, reply: "flaky" },
      { when: {}, reply: "stable" },
    ])!;
    const replies = new Set(
      Array.from({ length: 20 }, () => engine.match(context())!.reply),
    );
    expect(replies.has("flaky")).toBe(true);
    expect(replies.has("stable")).toBe(true);
  });

  it("sequence state is per engine instance", () => {
    const build = () => createRuleEngine([{ when: {}, sequence: ["only"] }])!;
    expect(build().match(context())!.reply).toBe("only");
    expect(build().match(context())!.reply).toBe("only");
  });
});

describe("fault outcomes (unit)", () => {
  it("carries status and retry fields with no reply", () => {
    const engine = createRuleEngine([
      {
        when: {},
        status: 429,
        retryAfterSec: 3,
        errorType: "custom_error",
        errorMessage: "slow down",
      },
    ])!;
    expect(engine.match(context())).toEqual({
      reply: undefined,
      status: 429,
      retryAfterSec: 3,
      errorType: "custom_error",
      errorMessage: "slow down",
      malformedJson: undefined,
      timeoutAfterMs: undefined,
      thinkingOnly: undefined,
      delayMs: undefined,
    });
  });

  it("carries thinkingOnly with no reply", () => {
    const engine = createRuleEngine([
      { when: {}, thinkingOnly: "Let me work through this." },
    ])!;
    expect(engine.match(context())).toEqual({
      reply: undefined,
      status: undefined,
      retryAfterSec: undefined,
      errorType: undefined,
      errorMessage: undefined,
      malformedJson: undefined,
      timeoutAfterMs: undefined,
      thinkingOnly: "Let me work through this.",
      delayMs: undefined,
    });
  });

  it("carries malformedJson, timeoutAfterMs, and delayMs", () => {
    const engine = createRuleEngine([
      { when: {}, malformedJson: true, timeoutAfterMs: 100, delayMs: 5 },
    ])!;
    const outcome = engine.match(context())!;
    expect(outcome.malformedJson).toBe(true);
    expect(outcome.timeoutAfterMs).toBe(100);
    expect(outcome.delayMs).toBe(5);
  });

  it("a delay-only rule delays the fallback reply", () => {
    const engine = createRuleEngine([{ when: {}, delayMs: 50 }])!;
    expect(engine.match(context())).toEqual({
      reply: undefined,
      status: undefined,
      retryAfterSec: undefined,
      errorType: undefined,
      errorMessage: undefined,
      malformedJson: undefined,
      timeoutAfterMs: undefined,
      delayMs: 50,
    });
  });
});
