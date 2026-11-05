import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditRunSettings,
  parseAgentModelList,
  parseAuditEffort,
  resolveCursorModelForRun,
} from "../src/audit-settings.ts";

test("parseAgentModelList reads agent --list-models lines", () => {
  const stdout = `Available models

claude-opus-5-5-low - Claude Opus 5.5 1M Low
claude-opus-5-5-high - Claude Opus 5.5 1M High
`;
  const options = parseAgentModelList(stdout);
  assert.deepEqual(options.map((row) => row.value), ["claude-opus-5-5-low", "claude-opus-5-5-high"]);
});

test("auditRunSettings uses request effort and explicit cursor model", () => {
  const saved = process.env.MIRROR_AI_EFFORT;
  process.env.MIRROR_AI_EFFORT = "high";
  try {
    assert.deepEqual(auditRunSettings({ effort: "low" }), { effort: "low", cursorModel: null });
    assert.deepEqual(auditRunSettings({ cursorModel: "gemini-4-argon-low" }), {
      effort: "high",
      cursorModel: "gemini-4-argon-low",
    });
    assert.equal(resolveCursorModelForRun(auditRunSettings({ effort: "medium" })), "claude-opus-5-5-medium");
    assert.equal(
      resolveCursorModelForRun(auditRunSettings({ cursorModel: "claude-opus-5-5-low" })),
      "claude-opus-5-5-low",
    );
  } finally {
    if (saved === undefined) delete process.env.MIRROR_AI_EFFORT;
    else process.env.MIRROR_AI_EFFORT = saved;
  }
});

test("parseAuditEffort rejects unknown values", () => {
  assert.equal(parseAuditEffort("high"), "high");
  assert.equal(parseAuditEffort("turbo"), null);
});
