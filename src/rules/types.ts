type ProviderId = "anthropic" | "openai";

// The four declarative guard operators of llm-mock's mini-DSL, evaluated
// against the variables captured by `when.pattern`.
type RuleGuardOp = "equals" | "includes" | "oneOf" | "matches";

type RuleGuard = {
  readonly op: RuleGuardOp;
  // The captured variable name the operator examines.
  readonly var: string;
  // The operand for equals/includes/matches (a regex source for matches).
  readonly value?: string;
  // The operand set for oneOf.
  readonly values?: readonly string[];
};

type RuleWhen = {
  // A {{var}} template compiled to a case-insensitive, whitespace-tolerant
  // regex anchored to the whole last user message. Omitted matches any text.
  readonly pattern?: string;
  // Restricts the rule to one provider (or a list), by id.
  readonly provider?: string | readonly string[];
  // Restricts the rule to one model (or a list), exact match.
  readonly model?: string | readonly string[];
  // Every entry must equal the request header of the same (case-insensitive)
  // name.
  readonly headers?: Readonly<Record<string, string>>;
  // Matches only requests whose `stream` flag equals this value.
  readonly stream?: boolean;
};

// Adapted from npm `llm-mock`'s cases/guards/scenarios (ADR 0008): a rule
// routes requests by pattern and conditions to a reply or a fault. At least
// one outcome field (reply, sequence, status, malformedJson, timeoutAfterMs,
// delayMs) is required.
type MockRule = {
  readonly when: RuleWhen;
  // The reply text, always {{var}}-interpolated with the captured variables.
  readonly reply?: string;
  // Ordered replies across successive matching requests; the last entry
  // repeats once the sequence is exhausted (linear; no branching).
  readonly sequence?: readonly string[];
  // Probability in [0, 1] that an otherwise-matching rule fires; a failed
  // roll falls through to later rules without consuming a sequence step.
  readonly ratio?: number;
  readonly guard?: RuleGuard;
  // Any HTTP status code, served as a provider-shaped error body.
  readonly status?: number;
  // Sent as the `retry-after` header alongside `status`.
  readonly retryAfterSec?: number;
  // Overrides the error type mapped from `status`.
  readonly errorType?: string;
  // Overrides the error message mapped from the error type.
  readonly errorMessage?: string;
  // 200 with the truncated body '{"not":"closed"' — valid JSON headers,
  // unparsable payload.
  readonly malformedJson?: boolean;
  // Hangs for this many milliseconds, then destroys the socket. Unlike
  // llm-mock's TIMEOUT (which never responds), the hang is bounded so tests
  // terminate.
  readonly timeoutAfterMs?: number;
  // Streams a response whose only content is a signed thinking block with
  // this text — no answer text, no tool call, normal end of stream: the
  // provider half of goose#11975's silent turn end.
  readonly thinkingOnly?: string;
  // Fixed delay before the response (fault or reply).
  readonly delayMs?: number;
};

// A matched rule's outcome: the resolved reply (undefined for fault-only
// rules) plus the fault fields.
type RuleOutcome = {
  readonly reply?: string;
  readonly status?: number;
  readonly retryAfterSec?: number;
  readonly errorType?: string;
  readonly errorMessage?: string;
  readonly malformedJson?: boolean;
  readonly timeoutAfterMs?: number;
  readonly thinkingOnly?: string;
  readonly delayMs?: number;
};

// The request facts a rule is matched against.
type RuleRequestContext = {
  readonly provider: ProviderId;
  readonly model: string;
  readonly text: string;
  // Header values may be arrays (repeated headers); lookups are by the
  // lowercased name fastify normalizes to.
  readonly headers: Readonly<Record<string, unknown>>;
  readonly stream: boolean;
};

type RuleEngine = {
  // Returns the first rule's outcome that matches the context, or undefined.
  readonly match: (context: RuleRequestContext) => RuleOutcome | undefined;
};

export type {
  MockRule,
  ProviderId,
  RuleEngine,
  RuleGuard,
  RuleGuardOp,
  RuleOutcome,
  RuleRequestContext,
  RuleWhen,
};
