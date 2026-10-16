import { type } from "arktype";

import type { MockRule } from "./types";

// Every {{...}} occurrence must be a single well-formed identifier so the
// compiled regex's named groups are valid (JS group names cannot start with
// a digit).
const PLACEHOLDER_LIKE = /\{\{[^}]*\}\}/g;
const PLACEHOLDER_EXACT = /^\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/;

const validPatternPlaceholders = (pattern: string): boolean => {
  for (const match of pattern.matchAll(PLACEHOLDER_LIKE))
    if (!PLACEHOLDER_EXACT.test(match[0])) return false;
  return true;
};

// A rule must produce something: a reply, a sequence, or any fault outcome
// (delayMs alone is meaningful — it delays the fallback reply).
const hasOutcome = (
  rule: Pick<
    MockRule,
    | "reply"
    | "sequence"
    | "status"
    | "malformedJson"
    | "timeoutAfterMs"
    | "thinkingOnly"
    | "delayMs"
  >,
): boolean =>
  rule.reply !== undefined ||
  (rule.sequence !== undefined && rule.sequence.length > 0) ||
  rule.status !== undefined ||
  rule.malformedJson === true ||
  rule.timeoutAfterMs !== undefined ||
  rule.thinkingOnly !== undefined ||
  rule.delayMs !== undefined;

const ruleGuard = type({
  op: "'equals' | 'includes' | 'oneOf' | 'matches'",
  var: "string",
  "value?": "string",
  "values?": "string[]",
});

const ruleWhen = type({
  "pattern?": "string",
  "provider?": "string | string[]",
  "model?": "string | string[]",
  "headers?": "Record<string, string>",
  "stream?": "boolean",
}).narrow((when, ctx) =>
  when.pattern === undefined || validPatternPlaceholders(when.pattern)
    ? true
    : ctx.mustBe("a template whose {{var}} placeholders are identifiers"),
);

const mockRuleSchema = type({
  when: ruleWhen,
  "reply?": "string",
  "sequence?": "string[]",
  "ratio?": "0 <= number <= 1",
  "guard?": ruleGuard,
  "status?": "number.integer",
  "retryAfterSec?": "number",
  "errorType?": "string",
  "errorMessage?": "string",
  "malformedJson?": "boolean",
  "timeoutAfterMs?": "number >= 0",
  "thinkingOnly?": "string",
  "delayMs?": "number >= 0",
})
  .onUndeclaredKey("reject")
  .narrow(hasOutcome);

const rulesEnvelopeSchema = type({ rules: mockRuleSchema.array() });

// Unwraps a {"rules": [...]} envelope; a bare array and anything else are
// passed through, so invalid shapes reach the array validation, whose error
// names the actual problem.
const rulesFromEnvelope = (raw: unknown): unknown => {
  if (Array.isArray(raw)) return raw;
  const envelope = rulesEnvelopeSchema(raw);
  return envelope instanceof type.errors ? raw : envelope.rules;
};

// Validates raw JSON into rules, throwing a readable error naming the
// source (the file path, or "rules") when anything is off.
const parseRules = (raw: unknown, source: string): readonly MockRule[] => {
  const result = mockRuleSchema.array()(rulesFromEnvelope(raw));
  if (result instanceof type.errors)
    throw new Error(
      `llm-mockingbird: invalid rules in ${source}: ${result.summary}`,
    );

  return result;
};

export { parseRules };
