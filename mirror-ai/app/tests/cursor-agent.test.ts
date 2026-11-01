import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pickRunner } from "../src/audit.ts";
import { hasCursorAgentCli, resolveCursorModel } from "../src/cursor-agent.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bin = path.join(root, "tests/bin");

test("pickRunner prefers cursor in a Cursor session when agent is on PATH", () => {
  const saved = {
    runner: process.env.MIRROR_AI_RUNNER,
    agent: process.env.CURSOR_AGENT,
    path: process.env.PATH,
  };
  try {
    delete process.env.MIRROR_AI_RUNNER;
    process.env.CURSOR_AGENT = "1";
    process.env.PATH = `${bin}${path.delimiter}${saved.path ?? ""}`;
    assert.equal(pickRunner(), "cursor");
  } finally {
    if (saved.runner === undefined) delete process.env.MIRROR_AI_RUNNER;
    else process.env.MIRROR_AI_RUNNER = saved.runner;
    if (saved.agent === undefined) delete process.env.CURSOR_AGENT;
    else process.env.CURSOR_AGENT = saved.agent;
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
  }
});

test("resolveCursorModel uses an agent CLI model slug", () => {
  const saved = process.env.MIRROR_AI_CURSOR_MODEL;
  try {
    delete process.env.MIRROR_AI_CURSOR_MODEL;
    assert.equal(resolveCursorModel("high"), "claude-opus-5-5-high");
    assert.equal(resolveCursorModel("medium"), "claude-opus-5-5-medium");
    assert.equal(resolveCursorModel("max"), "claude-opus-5-5-high");
    process.env.MIRROR_AI_CURSOR_MODEL = "gpt-5.4";
    assert.equal(resolveCursorModel("low"), "gpt-5.4");
    process.env.MIRROR_AI_CURSOR_MODEL = "claude-opus-5-5-high";
    assert.equal(resolveCursorModel("low"), "claude-opus-5-5-high");
    process.env.MIRROR_AI_CURSOR_MODEL = "claude-opus-5-5[effort=low]";
    assert.equal(resolveCursorModel("high"), "claude-opus-5-5-low");
  } finally {
    if (saved === undefined) delete process.env.MIRROR_AI_CURSOR_MODEL;
    else process.env.MIRROR_AI_CURSOR_MODEL = saved;
  }
});

test("pickRunner falls back when agent is installed but not logged in", () => {
  const saved = {
    runner: process.env.MIRROR_AI_RUNNER,
    agent: process.env.CURSOR_AGENT,
    path: process.env.PATH,
    stubLogin: process.env.MIRROR_AI_AGENT_STUB_LOGIN,
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
  try {
    delete process.env.MIRROR_AI_RUNNER;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CURSOR_AGENT = "1";
    process.env.MIRROR_AI_AGENT_STUB_LOGIN = "0";
    process.env.PATH = `${bin}${path.delimiter}${saved.path ?? ""}`;
    assert.equal(pickRunner(), "cli");
  } finally {
    if (saved.runner === undefined) delete process.env.MIRROR_AI_RUNNER;
    else process.env.MIRROR_AI_RUNNER = saved.runner;
    if (saved.agent === undefined) delete process.env.CURSOR_AGENT;
    else process.env.CURSOR_AGENT = saved.agent;
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
    if (saved.stubLogin === undefined) delete process.env.MIRROR_AI_AGENT_STUB_LOGIN;
    else process.env.MIRROR_AI_AGENT_STUB_LOGIN = saved.stubLogin;
    if (saved.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.apiKey;
  }
});

test("hasCursorAgentCli finds the test stub", () => {
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
  try {
    assert.equal(hasCursorAgentCli(), true);
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
});
