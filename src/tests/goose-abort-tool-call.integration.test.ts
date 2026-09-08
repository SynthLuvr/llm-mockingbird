import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAnthropicMock } from "../create-mock";
import {
  createScratch,
  GOOSE_TIMEOUT_MS,
  gooseInstalled,
  gooseOutput,
  runGoose,
  type Scratch,
  startMock,
  TEST_TIMEOUT_MS,
  teardown,
  writeGooseProfile,
} from "./goose-helpers";

// Reproduces aaif-goose/goose#11909: a headless `goose run` aborted during a
// tool call (1) loses the entire in-flight round — the assistant message and
// its toolRequest are only persisted at iteration end, after all tools finish
// — and (2) still reports success, because the CLI's cancel/error arms print
// to the terminal and return Ok, so log_session_completion logs
// exit_type "normal" and the process exits 0.
//
// The mock scripts one Anthropic round whose reply is a tool_use block for
// the developer extension's shell tool running `sleep 30`. Once goose's own
// log records "Tool call started" for that round, the test sends SIGINT and
// inspects the exit code, the completion log line, and the scratch sessions
// database. Every assertion marked BUG captures the defective behaviour and
// must be inverted once goose persists the round write-ahead and reports
// aborted headless runs honestly.

// Long enough that the tool is still running when SIGINT lands; short
// enough that an unnoticed early exit fails the test fast.
const TOOL_SLEEP_SECS = 30;

// Grace period for goose startup plus the scripted LLM round.
const TOOL_START_TIMEOUT_MS = 45_000;

// Time between seeing "Tool call started" and sending SIGINT; the abort
// must land while the sleep is in flight.
const SIGINT_SETTLE_MS = 1_000;

const LOG_POLL_INTERVAL_MS = 200;

const TOOL_REQUEST_ID = "toolu_mock_11909";
const MESSAGE_ID = "msg_mock_11909";

// The DB assertions shell out to the sqlite3 CLI; skip when it is absent.
const sqlite3Installed =
  execSync("command -v sqlite3 || true").toString().trim().length > 0;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// goose writes JSON logs under <state>/goose/logs/cli/<day>/*.json.
const cliLogFiles = (stateHome: string): readonly string[] => {
  const base = join(stateHome, "goose", "logs", "cli");
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((day) =>
    readdirSync(join(base, day)).map((file) => join(base, day, file)),
  );
};

const findLogLine = (stateHome: string, needle: string): string | undefined => {
  for (const file of cliLogFiles(stateHome))
    for (const line of readFileSync(file, "utf8").split("\n"))
      if (line.includes(needle)) return line;
  return undefined;
};

const waitForLogLine = async (
  stateHome: string,
  needle: string,
  timeoutMs: number,
): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = findLogLine(stateHome, needle);
    if (line !== undefined) return line;
    await delay(LOG_POLL_INTERVAL_MS);
  }
  return undefined;
};

const sessionDbPath = (scratch: Scratch): string =>
  join(scratch.dataHome, "goose", "sessions", "sessions.db");

const querySessionDb = (scratch: Scratch, sql: string): number =>
  Number(
    execSync(
      `sqlite3 ${JSON.stringify(sessionDbPath(scratch))} ${JSON.stringify(sql)}`,
    )
      .toString()
      .trim(),
  );

const sseFrame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// One assistant round that ends in a shell tool call, streamed as Anthropic
// SSE (the shape the real API sends for tool use).
const toolUseStream = (): string =>
  [
    sseFrame("message_start", {
      type: "message_start",
      message: {
        id: MESSAGE_ID,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: TOOL_REQUEST_ID,
        name: "shell",
        input: {},
      },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          command: `sleep ${TOOL_SLEEP_SECS}`,
        }),
      },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 32 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join("");

// Answers the first main (non-title) completion request with the scripted
// tool round; later requests fall through to the mock's canned behaviour.
const serveToolRoundOnFirstMainRequest = (app: FastifyInstance): void => {
  let served = false;
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST" || request.url !== "/v1/messages") return;
    if (served) return;
    const body = (request.body ?? {}) as {
      system?: unknown;
      stream?: boolean;
    };
    const system =
      typeof body.system === "string"
        ? body.system
        : JSON.stringify(body.system ?? "");
    if (system.includes("title")) return;
    served = true;
    if (body.stream === false) {
      await reply.code(200).send({
        id: MESSAGE_ID,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [
          {
            type: "tool_use",
            id: TOOL_REQUEST_ID,
            name: "shell",
            input: { command: `sleep ${TOOL_SLEEP_SECS}` },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 32 },
      });
      return;
    }
    await reply.code(200).type("text/event-stream").send(toolUseStream());
  });
};

describe.skipIf(!gooseInstalled || !sqlite3Installed)(
  "goose CLI abort during tool call (integration, aaif-goose/goose#11909)",
  () => {
    let scratch: Scratch;
    let app: FastifyInstance;

    beforeEach(() => {
      scratch = createScratch();
    });

    afterEach(() => teardown(app, scratch));

    it(
      "exits 0 with exit_type normal and drops the in-flight round when SIGINT lands mid tool call",
      async () => {
        writeGooseProfile(scratch.configHome, "anthropic", "claude-sonnet-4-5");

        app = createAnthropicMock({ cannedResponse: "all done" });
        serveToolRoundOnFirstMainRequest(app);
        const url = await startMock(app);

        const goose = runGoose(
          scratch,
          "anthropic",
          url,
          `Use the shell tool to run exactly: sleep ${TOOL_SLEEP_SECS} && echo done. Then report the output.`,
          GOOSE_TIMEOUT_MS,
          { persistSession: true, withBuiltins: ["developer"] },
        );

        const startedLine = await waitForLogLine(
          scratch.stateHome,
          "Tool call started",
          TOOL_START_TIMEOUT_MS,
        );
        if (startedLine === undefined) {
          goose.kill("SIGKILL");
          await goose;
        }
        // Precondition: the scripted round really reached tool execution,
        // so the abort below lands on a round that exists only in memory.
        expect(
          startedLine,
          "goose never started the scripted shell tool call",
        ).toBeDefined();
        expect(startedLine).toContain('"tool_name":"shell"');

        await delay(SIGINT_SETTLE_MS);
        goose.kill("SIGINT");
        const result = await goose;
        const output = gooseOutput(result);

        // BUG (goose#11909, defect 2): the cancel arm drops the stream and
        // returns Ok, so the headless run exits 0 as if it had completed.
        // A fixed goose should fail (non-zero exit or exit_type "error").
        expect(result.exitCode, output).toBe(0);

        const completionLine = findLogLine(
          scratch.stateHome,
          "Session completed",
        );
        expect(completionLine).toBeDefined();
        // BUG: completion telemetry derives exit_type from result.is_ok(),
        // so a run killed mid-task is recorded as "normal".
        expect(completionLine).toContain('"exit_type":"normal"');

        // BUG (goose#11909, defect 1): the round that produced the tool call
        // was never persisted. The session ends on the kickoff user turn
        // only; the assistant toolRequest, its toolResponse, and the round's
        // usage are all absent even though the LLM call and the shell
        // execution really happened. A fixed goose that persists write-ahead
        // would leave an assistant row here.
        expect(
          querySessionDb(
            scratch,
            "SELECT COUNT(*) FROM messages WHERE role = 'assistant';",
          ),
        ).toBe(0);
        expect(
          querySessionDb(
            scratch,
            "SELECT COUNT(*) FROM messages WHERE content_json LIKE '%tool_use%';",
          ),
        ).toBe(0);
        expect(
          querySessionDb(scratch, "SELECT COUNT(*) FROM usage_ledger;"),
        ).toBe(0);
        // Sanity: the kickoff user turn was persisted before the round.
        expect(
          querySessionDb(
            scratch,
            "SELECT COUNT(*) FROM messages WHERE role = 'user';",
          ),
        ).toBeGreaterThanOrEqual(1);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
