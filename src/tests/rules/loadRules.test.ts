import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadRulesFile } from "../../rules/loadRules";

const roots: string[] = [];

// Each test gets its own directory so rule files never collide.
const writeRules = (contents: string): string => {
  const root = mkdtempSync(join(tmpdir(), "llm-mockingbird-rules-"));
  roots.push(root);
  const path = join(root, "rules.json");
  writeFileSync(path, contents);
  return path;
};

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("loadRulesFile (unit)", () => {
  it("loads a bare JSON array of rules", () => {
    const path = writeRules(
      JSON.stringify([
        { when: { pattern: "hi {{name}}" }, reply: "yo {{name}}" },
      ]),
    );
    expect(loadRulesFile(path)).toEqual([
      { when: { pattern: "hi {{name}}" }, reply: "yo {{name}}" },
    ]);
  });

  it("loads a { rules: [...] } envelope", () => {
    const path = writeRules(
      JSON.stringify({
        rules: [{ when: { provider: "openai" }, status: 429 }],
      }),
    );
    expect(loadRulesFile(path)).toEqual([
      { when: { provider: "openai" }, status: 429 },
    ]);
  });

  it("accepts a rule whose only outcome is thinkingOnly", () => {
    const path = writeRules(
      JSON.stringify([{ when: {}, thinkingOnly: "Hmm..." }]),
    );
    expect(loadRulesFile(path)).toEqual([{ when: {}, thinkingOnly: "Hmm..." }]);
  });

  it("rejects invalid JSON, naming the file", () => {
    const path = writeRules("{not json");
    expect(() => loadRulesFile(path)).toThrow(/not valid JSON/);
    // Windows paths contain backslashes, which are regex escapes unless
    // escaped themselves.
    expect(() => loadRulesFile(path)).toThrow(
      new RegExp(path.replaceAll("\\", "\\\\")),
    );
  });

  it("rejects an unreadable file", () => {
    expect(() => loadRulesFile(join(tmpdir(), "no-such-rules.json"))).toThrow(
      /cannot read rules file/,
    );
  });

  it("rejects a rule with an out-of-range ratio", () => {
    const path = writeRules(
      JSON.stringify([{ when: {}, ratio: 2, reply: "x" }]),
    );
    expect(() => loadRulesFile(path)).toThrow(/ratio/);
  });

  it("rejects an unknown field (catches typos)", () => {
    const path = writeRules(
      JSON.stringify([{ when: {}, reply: "x", statuss: 500 }]),
    );
    expect(() => loadRulesFile(path)).toThrow(/invalid rules/);
  });

  it("rejects a rule with no outcome", () => {
    const path = writeRules(JSON.stringify([{ when: { pattern: "hi" } }]));
    expect(() => loadRulesFile(path)).toThrow(/invalid rules/);
  });

  it("rejects an invalid pattern placeholder name", () => {
    const path = writeRules(
      JSON.stringify([{ when: { pattern: "hi {{1nvalid}}" }, reply: "x" }]),
    );
    expect(() => loadRulesFile(path)).toThrow(/placeholders/);
  });

  it("rejects a non-object, non-array document", () => {
    const path = writeRules(JSON.stringify("just a string"));
    expect(() => loadRulesFile(path)).toThrow(/invalid rules/);
  });
});
