import type { FastifyRequest } from "fastify";

import { compilePattern, interpolate, type PatternMatcher } from "./patterns";
import type {
  MockRule,
  ProviderId,
  RuleEngine,
  RuleGuard,
  RuleOutcome,
  RuleRequestContext,
  RuleWhen,
} from "./types";

// True when the condition is the actual value, or a list containing it.
const includesValue = (
  condition: string | readonly string[],
  actual: string,
): boolean =>
  typeof condition === "string"
    ? condition === actual
    : condition.includes(actual);

// Header names are case-insensitive: fastify lowercases request header
// keys, so condition names are lowercased before lookup. Repeated headers
// arrive as arrays and match when any member equals the value.
const headersMatch = (
  condition: Readonly<Record<string, string>>,
  requestHeaders: Readonly<Record<string, unknown>>,
): boolean =>
  Object.entries(condition).every(([name, value]) => {
    const actual = requestHeaders[name.toLowerCase()];
    return Array.isArray(actual) ? actual.includes(value) : actual === value;
  });

const whenMatches = (when: RuleWhen, context: RuleRequestContext): boolean => {
  if (
    when.provider !== undefined &&
    !includesValue(when.provider, context.provider)
  )
    return false;
  if (when.model !== undefined && !includesValue(when.model, context.model))
    return false;
  if (
    when.headers !== undefined &&
    !headersMatch(when.headers, context.headers)
  )
    return false;
  return when.stream === undefined || when.stream === context.stream;
};

// llm-mock's guard mini-DSL: equals/includes/oneOf compare
// case-insensitively, matches is a case-sensitive regex test. A variable the
// pattern did not capture is treated as the empty string.
const guardPasses = (
  guard: RuleGuard,
  vars: Readonly<Record<string, string>>,
): boolean => {
  const actual = vars[guard.var] ?? "";
  switch (guard.op) {
    case "equals":
      return actual.toLowerCase() === (guard.value ?? "").toLowerCase();
    case "includes":
      return actual.toLowerCase().includes((guard.value ?? "").toLowerCase());
    case "oneOf":
      return (guard.values ?? []).some(
        (value) => actual.toLowerCase() === value.toLowerCase(),
      );
    case "matches":
      return new RegExp(guard.value ?? "").test(actual);
  }
};

// The reply template for a rule's nth match: a sequence repeats its last
// entry forever; without one, the single `reply`. A sequence wins when both
// are set.
const replyTemplate = (rule: MockRule, hits: number): string | undefined =>
  rule.sequence !== undefined && rule.sequence.length > 0
    ? rule.sequence[Math.min(hits, rule.sequence.length - 1)]
    : rule.reply;

type CompiledRule = {
  readonly rule: MockRule;
  readonly pattern: PatternMatcher | undefined;
  hits: number;
};

// Routes a request to the first rule whose when conditions, pattern, guard,
// and ratio roll succeed. Sequence state is per rule, per engine — that is,
// per mock instance.
const createRuleEngine = (
  rules: readonly MockRule[] | undefined,
): RuleEngine | undefined => {
  if (rules === undefined || rules.length === 0) return undefined;

  const compiled: CompiledRule[] = rules.map((rule) => ({
    rule,
    pattern:
      rule.when.pattern === undefined
        ? undefined
        : compilePattern(rule.when.pattern),
    hits: 0,
  }));

  const match = (context: RuleRequestContext): RuleOutcome | undefined => {
    for (const entry of compiled) {
      const { rule } = entry;
      if (!whenMatches(rule.when, context)) continue;
      const vars =
        entry.pattern === undefined ? {} : entry.pattern(context.text);
      if (vars === null) continue;
      if (rule.guard !== undefined && !guardPasses(rule.guard, vars)) continue;
      // The ratio roll precedes the sequence counter, so a skipped request
      // does not consume a sequence step.
      if (rule.ratio !== undefined && Math.random() >= rule.ratio) continue;

      const template = replyTemplate(rule, entry.hits);
      entry.hits += 1;
      return {
        reply: template === undefined ? undefined : interpolate(template, vars),
        status: rule.status,
        retryAfterSec: rule.retryAfterSec,
        errorType: rule.errorType,
        errorMessage: rule.errorMessage,
        malformedJson: rule.malformedJson,
        timeoutAfterMs: rule.timeoutAfterMs,
        thinkingOnly: rule.thinkingOnly,
        delayMs: rule.delayMs,
      };
    }
    return undefined;
  };

  return { match };
};

// Matches a completion request against the engine: undefined when no engine
// is configured or nothing matches.
const matchRule = (
  engine: RuleEngine | undefined,
  provider: ProviderId,
  request: FastifyRequest,
  model: string,
  stream: boolean,
): RuleOutcome | undefined =>
  engine?.match({
    provider,
    model,
    text: extractUserText(request.body),
    headers: request.headers,
    stream,
  });

// The text rules match against: the last user message's content, joining
// the text parts of array content (both providers share the message shape).
const extractUserText = (body: unknown): string => {
  if (typeof body !== "object" || body === null) return "";
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";
  const lastUser = messages.findLast(
    (message): message is { content: unknown } =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "user",
  );
  if (lastUser === undefined) return "";
  if (typeof lastUser.content === "string") return lastUser.content;
  if (!Array.isArray(lastUser.content)) return "";
  return lastUser.content
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join(" ");
};

export { createRuleEngine, matchRule };
