import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { MockRule } from "../../rules/types";
import { startOpenAITestServer, startTestServer } from "../helpers";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const postMessages = (
  url: string,
  messages: readonly unknown[],
  stream = true,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      messages,
      stream,
    }),
  });

const postCompletion = (
  url: string,
  messages: readonly unknown[],
  stream = false,
  headers: Record<string, string> = {},
  model = "gpt-4o",
): Promise<Response> =>
  fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages, stream }),
  });

// Joins an Anthropic stream's text_delta payloads into the full reply.
const anthropicText = (body: string): string =>
  [...body.matchAll(/data: (\{.*\})\n/g)]
    .map((match) => JSON.parse(match[1]) as { delta?: { text?: string } })
    .map((event) => event.delta?.text ?? "")
    .join("");

// Joins an OpenAI stream's delta contents into the full reply.
const openaiStreamText = (body: string): string =>
  [...body.matchAll(/data: (\{.*\})\n/g)]
    .map((match) => JSON.parse(match[1]) as Record<string, unknown>)
    .map((chunk) => {
      const choices = chunk.choices as
        | readonly { readonly delta?: { readonly content?: string } }[]
        | undefined;
      return choices?.[0]?.delta?.content ?? "";
    })
    .join("");

const completionContent = async (response: Response): Promise<string> => {
  const parsed = (await response.json()) as {
    choices?: readonly { readonly message?: { readonly content?: string } }[];
  };
  return parsed.choices?.[0]?.message?.content ?? "";
};

// Asserts that a request matching no rule falls back to the canned reply.
const expectCannedFallback = async (url: string): Promise<void> => {
  const plain = await postCompletion(url, [{ role: "user", content: "hi" }]);
  expect(await completionContent(plain)).toContain(
    "canned response from llm-mockingbird",
  );
};

describe("rule replies (integration)", () => {
  it("serves an interpolated anthropic rule reply as the SSE stream", async () => {
    const rules: readonly MockRule[] = [
      {
        when: { pattern: "my name is {{name}}" },
        reply: "Nice to meet you, {{name}}.",
      },
    ];
    const server = await startTestServer({ rules });
    try {
      // Case-insensitive and whitespace-tolerant, like npm llm-mock.
      const response = await postMessages(server.url, [
        { role: "user", content: "My   NAME is  Ada Lovelace " },
      ]);
      expect(response.status).toBe(200);
      expect(anthropicText(await response.text())).toBe(
        "Nice to meet you, Ada Lovelace.",
      );
    } finally {
      await server.close();
    }
  });

  it("extracts text from array content parts", async () => {
    const server = await startTestServer({
      rules: [
        { when: { pattern: "explain {{topic}}" }, reply: "About {{topic}}" },
      ],
    });
    try {
      const response = await postMessages(server.url, [
        {
          role: "user",
          content: [{ type: "text", text: "Explain quantum computing" }],
        },
      ]);
      expect(anthropicText(await response.text())).toBe(
        "About quantum computing",
      );
    } finally {
      await server.close();
    }
  });

  it("serves an openai rule reply non-streaming", async () => {
    const server = await startOpenAITestServer({
      rules: [
        {
          when: { provider: "openai", pattern: "say {{word}}" },
          reply: "You said {{word}}",
        },
      ],
    });
    try {
      const response = await postCompletion(server.url, [
        { role: "user", content: "Say  mockbird" },
      ]);
      expect(response.status).toBe(200);
      expect(await completionContent(response)).toBe("You said mockbird");
    } finally {
      await server.close();
    }
  });

  it("serves an openai rule reply streaming", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: {}, reply: "streamed rule reply" }],
    });
    try {
      const response = await postCompletion(
        server.url,
        [{ role: "user", content: "anything" }],
        true,
      );
      expect(response.status).toBe(200);
      expect(openaiStreamText(await response.text())).toBe(
        "streamed rule reply",
      );
    } finally {
      await server.close();
    }
  });

  it("walks a sequence across successive matching requests", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: { pattern: "next" }, sequence: ["one", "two", "three"] }],
    });
    try {
      const ask = () =>
        postCompletion(server.url, [{ role: "user", content: "next" }]).then(
          completionContent,
        );
      expect(await ask()).toBe("one");
      expect(await ask()).toBe("two");
      expect(await ask()).toBe("three");
      // The last entry repeats.
      expect(await ask()).toBe("three");
    } finally {
      await server.close();
    }
  });

  it("routes by model", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: { model: "gpt-4.1" }, reply: "from the special model" }],
    });
    try {
      const special = await postCompletion(
        server.url,
        [{ role: "user", content: "hi" }],
        false,
        {},
        "gpt-4.1",
      );
      expect(await completionContent(special)).toBe("from the special model");

      // No match: the canned response is served.
      await expectCannedFallback(server.url);
    } finally {
      await server.close();
    }
  });

  it("routes by request header", async () => {
    const server = await startOpenAITestServer({
      rules: [
        { when: { headers: { "X-Canary": "on" } }, reply: "canary reply" },
      ],
    });
    try {
      const canary = await postCompletion(
        server.url,
        [{ role: "user", content: "hi" }],
        false,
        { "x-canary": "on" },
      );
      expect(await completionContent(canary)).toBe("canary reply");

      await expectCannedFallback(server.url);
    } finally {
      await server.close();
    }
  });

  it("routes by stream flag", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: { stream: true }, reply: "streaming rule" }],
    });
    try {
      const streamed = await postCompletion(
        server.url,
        [{ role: "user", content: "hi" }],
        true,
      );
      expect(openaiStreamText(await streamed.text())).toBe("streaming rule");

      await expectCannedFallback(server.url);
    } finally {
      await server.close();
    }
  });

  it("routes by guard on captured variables", async () => {
    const server = await startOpenAITestServer({
      rules: [
        {
          when: { pattern: "deploy to {{env}}" },
          guard: { op: "oneOf", var: "env", values: ["prod", "staging"] },
          reply: "Careful! Deploying to {{env}}",
        },
        { when: {}, reply: "generic reply" },
      ],
    });
    try {
      const prod = await postCompletion(server.url, [
        { role: "user", content: "Deploy to Prod" },
      ]);
      expect(await completionContent(prod)).toBe("Careful! Deploying to Prod");

      const dev = await postCompletion(server.url, [
        { role: "user", content: "deploy to dev" },
      ]);
      expect(await completionContent(dev)).toBe("generic reply");
    } finally {
      await server.close();
    }
  });

  it("serves fallbackResponse when no rule matches", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: { pattern: "exact only" }, reply: "matched" }],
      fallbackResponse: "no rule for that",
    });
    try {
      const matched = await postCompletion(server.url, [
        { role: "user", content: "exact only" },
      ]);
      expect(await completionContent(matched)).toBe("matched");

      const unmatched = await postCompletion(server.url, [
        { role: "user", content: "something else" },
      ]);
      expect(await completionContent(unmatched)).toBe("no rule for that");
    } finally {
      await server.close();
    }
  });

  it("serves the canned response when no rules are configured", async () => {
    const server = await startOpenAITestServer({
      fallbackResponse: "no rule for that",
    });
    try {
      const response = await postCompletion(server.url, [
        { role: "user", content: "hi" },
      ]);
      // No rules configured: fallbackResponse outranks the canned text.
      expect(await completionContent(response)).toBe("no rule for that");
    } finally {
      await server.close();
    }
  });
});

describe("rule faults (integration)", () => {
  it("serves an openai-shaped 429 with retry-after", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: {}, status: 429, retryAfterSec: 3 }],
    });
    try {
      const response = await postCompletion(server.url, [
        { role: "user", content: "hi" },
      ]);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("3");
      await expect(response.json()).resolves.toEqual({
        error: {
          message: "Rate limit reached",
          type: "rate_limit_error",
          param: null,
          code: null,
        },
      });
    } finally {
      await server.close();
    }
  });

  it("serves an anthropic-shaped error body", async () => {
    const server = await startTestServer({
      rules: [{ when: {}, status: 401 }],
    });
    try {
      const response = await postMessages(server.url, [
        { role: "user", content: "hi" },
      ]);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        type: "error",
        error: { type: "authentication_error", message: "Invalid API key" },
      });
    } finally {
      await server.close();
    }
  });

  it("honours errorType and errorMessage overrides", async () => {
    const server = await startTestServer({
      rules: [
        {
          when: {},
          status: 500,
          errorType: "overloaded_error",
          errorMessage: "Totally fried",
        },
      ],
    });
    try {
      const response = await postMessages(server.url, [
        { role: "user", content: "hi" },
      ]);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        type: "error",
        error: { type: "overloaded_error", message: "Totally fried" },
      });
    } finally {
      await server.close();
    }
  });

  it("returns the status error before a stream starts", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: { stream: true }, status: 503 }],
    });
    try {
      const response = await postCompletion(
        server.url,
        [{ role: "user", content: "hi" }],
        true,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
    } finally {
      await server.close();
    }
  });

  it("sends malformed JSON with a 200", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: {}, malformedJson: true }],
    });
    try {
      const response = await postCompletion(server.url, [
        { role: "user", content: "hi" },
      ]);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      await expect(response.text()).resolves.toBe('{"not":"closed"');
    } finally {
      await server.close();
    }
  });

  it("hangs boundedly then destroys the socket (timeoutAfterMs)", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: {}, timeoutAfterMs: 120 }],
    });
    try {
      const start = Date.now();
      await expect(
        postCompletion(server.url, [{ role: "user", content: "hi" }]),
      ).rejects.toThrow();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(110);
      // Bounded: far under the test timeout, unlike llm-mock's TIMEOUT.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await server.close();
    }
  });

  it("delays the reply by delayMs", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: {}, reply: "slow reply", delayMs: 120 }],
    });
    try {
      const start = Date.now();
      const response = await postCompletion(server.url, [
        { role: "user", content: "hi" },
      ]);
      expect(await completionContent(response)).toBe("slow reply");
      expect(Date.now() - start).toBeGreaterThanOrEqual(110);
    } finally {
      await server.close();
    }
  });
});

describe("thinkingOnly fault (integration)", () => {
  // The default 16-char chunking splits the reasoning across deltas; a
  // single delta keeps the assertions on joined text simple.
  const CHUNK_SIZE = 200;
  const THINKING = "Let me work through this step by step.";

  it("streams a signed thinking block and no text on anthropic", async () => {
    const server = await startTestServer({
      streamChunkSize: CHUNK_SIZE,
      rules: [{ when: {}, thinkingOnly: THINKING }],
    });
    try {
      const response = await postMessages(server.url, [
        { role: "user", content: "hi" },
      ]);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(
        '"content_block":{"type":"thinking","thinking":""}',
      );
      expect(body).toContain(`"thinking_delta","thinking":"${THINKING}"`);
      expect(body).toContain('"signature_delta","signature":"');
      expect(body).toContain('"stop_reason":"end_turn"');
      expect(body).not.toContain('"type":"text_delta"');
    } finally {
      await server.close();
    }
  });

  it("streams reasoning_content deltas and no content on openai", async () => {
    const server = await startOpenAITestServer({
      streamChunkSize: CHUNK_SIZE,
      rules: [{ when: {}, thinkingOnly: THINKING }],
    });
    try {
      const response = await postCompletion(
        server.url,
        [{ role: "user", content: "hi" }],
        true,
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(`"reasoning_content":"${THINKING}"`);
      expect(body).toContain('"finish_reason":"stop"');
      expect(body).not.toContain('"content":"');
    } finally {
      await server.close();
    }
  });

  it("serves a reasoning-only message non-streaming on openai", async () => {
    const server = await startOpenAITestServer({
      rules: [{ when: {}, thinkingOnly: THINKING }],
    });
    try {
      const response = await postCompletion(server.url, [
        { role: "user", content: "hi" },
      ]);
      expect(response.status).toBe(200);
      const parsed = (await response.json()) as {
        choices: readonly {
          finish_reason: string;
          message: {
            content: string | null;
            reasoning_content?: string;
          };
        }[];
      };
      expect(parsed.choices[0].finish_reason).toBe("stop");
      expect(parsed.choices[0].message.content).toBeNull();
      expect(parsed.choices[0].message.reasoning_content).toBe(THINKING);
    } finally {
      await server.close();
    }
  });
});

describe("LLM_MOCKINGBIRD_RULES standalone server (integration)", () => {
  type MockChild = ChildProcessByStdio<null, Readable, Readable>;

  // Resolves the mock's url from the child's "listening on" line.
  const waitForUrl = async (child: MockChild): Promise<string> => {
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const match = output.match(/listening on (http:\/\/\S+)/);
      if (match) return match[1];
      if (child.exitCode !== null)
        throw new Error(`llm-mockingbird exited early: ${output.trim()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`llm-mockingbird did not start: ${output.trim()}`);
  };

  // Each test gets its own directory holding rules.json.
  const writeRulesFile = (
    prefix: string,
    contents: unknown,
  ): { root: string; path: string } => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    writeFileSync(join(root, "rules.json"), JSON.stringify(contents));
    return { root, path: join(root, "rules.json") };
  };

  const spawnRulesServer = (rulesPath: string): MockChild =>
    spawn(process.execPath, ["--import", "tsx", "src/server.ts", "anthropic"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        LLM_MOCKINGBIRD_RULES: rulesPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

  const stopServer = (child: MockChild): Promise<void> =>
    new Promise((resolve) => {
      child.kill("SIGTERM");
      child.on("close", () => resolve());
      setTimeout(resolve, 5_000);
    });

  it("serves rules loaded from a JSON file", { timeout: 30_000 }, async () => {
    const { root, path: rulesPath } = writeRulesFile(
      "llm-mockingbird-rules-env-",
      {
        rules: [
          {
            when: { pattern: "hello {{who}}" },
            reply: "Hello, {{who}}, from the rules file!",
          },
        ],
      },
    );
    const child = spawnRulesServer(rulesPath);
    try {
      const url = await waitForUrl(child);
      const response = await postMessages(url, [
        { role: "user", content: "Hello world" },
      ]);
      expect(response.status).toBe(200);
      expect(anthropicText(await response.text())).toBe(
        "Hello, world, from the rules file!",
      );
    } finally {
      await stopServer(child);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits with an error for an invalid rules file", {
    timeout: 30_000,
  }, async () => {
    const { root, path: rulesPath } = writeRulesFile(
      "llm-mockingbird-rules-bad-",
      [{ when: {}, ratio: 5 }],
    );
    const child = spawnRulesServer(rulesPath);
    const { stderr } = await new Promise<{ stderr: string }>((resolve) => {
      let output = "";
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.on("close", () => resolve({ stderr: output }));
    });
    expect(stderr).toContain("invalid rules");
    expect(stderr).toContain("ratio");
    rmSync(root, { recursive: true, force: true });
  });
});
