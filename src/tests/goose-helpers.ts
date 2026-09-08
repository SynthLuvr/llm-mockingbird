import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";

type GooseProvider = "anthropic" | "openai";

// Synchronous so describe.skipIf can branch at import time.
const gooseInstalled = (() => {
  try {
    execSync("command -v goose", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Isolates every XDG directory goose consults so the test never reads or
// mutates the user's real ~/.config/goose.
type Scratch = {
  readonly root: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly stateHome: string;
};

const createScratch = (): Scratch => {
  const root = mkdtempSync(join(tmpdir(), "goose-cli-int-"));
  const configHome = join(root, "config");
  const dataHome = join(root, "data");
  const stateHome = join(root, "state");
  mkdirSync(join(configHome, "goose"), { recursive: true });
  return { root, configHome, dataHome, stateHome };
};

const writeGooseProfile = (
  configHome: string,
  provider: GooseProvider,
  model: string,
): void => {
  const lines = [
    `active_provider: ${provider}`,
    "providers:",
    `  ${provider}:`,
    "    enabled: true",
    `    model: ${model}`,
    "    configured: true",
    "",
  ];
  writeFileSync(join(configHome, "goose", "config.yaml"), lines.join("\n"));
};

// <PROVIDER>_HOST points goose at the mock; the dummy API key satisfies
// goose's credential gate without touching the system keyring.
const providerEnv = (
  provider: GooseProvider,
  mockUrl: string,
): Record<string, string> => {
  const prefix = provider === "openai" ? "OPENAI" : "ANTHROPIC";
  return {
    [`${prefix}_HOST`]: mockUrl,
    [`${prefix}_API_KEY`]: "test-key",
  };
};

type RunGooseOptions = {
  // Omit --no-session so the run persists into the scratch sessions.db
  // (needed by tests that inspect goose's session database).
  readonly persistSession?: boolean;
  // Appends one --with-builtin flag per entry (e.g. "developer" for the
  // shell tool).
  readonly withBuiltins?: readonly string[];
};

const runGoose = (
  scratch: Scratch,
  provider: GooseProvider,
  mockUrl: string,
  prompt: string,
  timeoutMs = 60000,
  options: RunGooseOptions = {},
): ReturnType<typeof execa> => {
  const args = ["run", "-t", prompt];
  if (!options.persistSession) args.push("--no-session");
  for (const builtin of options.withBuiltins ?? [])
    args.push("--with-builtin", builtin);
  return execa("goose", args, {
    cwd: scratch.root,
    reject: false,
    timeout: timeoutMs,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: scratch.configHome,
      XDG_DATA_HOME: scratch.dataHome,
      XDG_STATE_HOME: scratch.stateHome,
      ...providerEnv(provider, mockUrl),
      GOOSE_TELEMETRY_ENABLED: "false",
    },
  });
};

// execa widens stdout/stderr to a union for non-default encodings; under the
// default utf8 encoding they are always strings.
const asText = (value: unknown): string =>
  typeof value === "string" ? value : "";

// Defensive backstop: a fast non-retryable 400 caps the runtime if a future
// goose retried aggressively. The current goose never reaches it.
const MAX_STREAMING_REQUESTS = 12;

const GOOSE_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 120_000;

type GooseResult = Awaited<ReturnType<typeof runGoose>>;

// goose fires the main response and a background title-generation request
// concurrently; title requests carry "title" in their system prompt.
const isMainRequest = (system: unknown): boolean => {
  const text =
    typeof system === "string" ? system : JSON.stringify(system ?? "");
  return !text.includes("title");
};

type RequestCounts = {
  readonly messages: () => number;
  readonly main: () => number;
};

// Counts POST /v1/messages requests, separating the main response from the
// concurrent title request, and caps the count with a non-retryable 400 so an
// aggressively-retrying goose can't loop forever.
const trackMessagesRequests = (app: FastifyInstance): RequestCounts => {
  let messages = 0;
  let main = 0;
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST" || request.url !== "/v1/messages") return;
    messages++;
    const body = (request.body ?? {}) as { system?: unknown };
    if (isMainRequest(body.system)) main++;
    if (messages > MAX_STREAMING_REQUESTS)
      return reply.code(400).send({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "llm-mockingbird loop breaker",
        },
      });
  });
  return { messages: () => messages, main: () => main };
};

const startMock = async (app: FastifyInstance): Promise<string> => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

// Combined, lower-cased goose stdout+stderr for substring/regex assertions.
const gooseOutput = (result: GooseResult): string =>
  `${asText(result.stdout)}\n${asText(result.stderr)}`.toLowerCase();

const teardown = async (
  app: FastifyInstance | undefined,
  scratch: Scratch,
): Promise<void> => {
  await app?.close();
  rmSync(scratch.root, { recursive: true, force: true });
};

export type { RunGooseOptions, Scratch };
export {
  asText,
  createScratch,
  GOOSE_TIMEOUT_MS,
  gooseInstalled,
  gooseOutput,
  MAX_STREAMING_REQUESTS,
  runGoose,
  startMock,
  TEST_TIMEOUT_MS,
  teardown,
  trackMessagesRequests,
  writeGooseProfile,
};
