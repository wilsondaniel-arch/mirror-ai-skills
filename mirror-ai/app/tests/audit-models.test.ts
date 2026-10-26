import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_API_MODEL,
  DEFAULT_CLI_MODEL,
  OPUS_55_API,
  OPUS_55_CLI,
  isCursorSession,
  resolveApiModel,
  resolveCliModel,
} from "../src/audit-models.ts";

test("Cursor session is detected from CURSOR_AGENT or CURSOR_CONVERSATION_ID", () => {
  const saved = {
    agent: process.env.CURSOR_AGENT,
    conversation: process.env.CURSOR_CONVERSATION_ID,
  };
  try {
    delete process.env.CURSOR_AGENT;
    delete process.env.CURSOR_CONVERSATION_ID;
    assert.equal(isCursorSession(), false);

    process.env.CURSOR_AGENT = "1";
    assert.equal(isCursorSession(), true);

    delete process.env.CURSOR_AGENT;
    process.env.CURSOR_CONVERSATION_ID = "abc";
    assert.equal(isCursorSession(), true);
  } finally {
    if (saved.agent === undefined) delete process.env.CURSOR_AGENT;
    else process.env.CURSOR_AGENT = saved.agent;
    if (saved.conversation === undefined) delete process.env.CURSOR_CONVERSATION_ID;
    else process.env.CURSOR_CONVERSATION_ID = saved.conversation;
  }
});

test("models default to Opus 5.5 in Cursor and legacy defaults elsewhere", () => {
  const saved = {
    agent: process.env.CURSOR_AGENT,
    api: process.env.MIRROR_AI_API_MODEL,
    cli: process.env.MIRROR_AI_CLI_MODEL,
  };
  try {
    delete process.env.MIRROR_AI_API_MODEL;
    delete process.env.MIRROR_AI_CLI_MODEL;
    delete process.env.CURSOR_AGENT;
    delete process.env.CURSOR_CONVERSATION_ID;
    assert.equal(resolveApiModel(), DEFAULT_API_MODEL);
    assert.equal(resolveCliModel(), DEFAULT_CLI_MODEL);

    process.env.CURSOR_AGENT = "1";
    assert.equal(resolveApiModel(), OPUS_55_API);
    assert.equal(resolveCliModel(), OPUS_55_CLI);

    process.env.MIRROR_AI_API_MODEL = "custom-api";
    process.env.MIRROR_AI_CLI_MODEL = "custom-cli";
    assert.equal(resolveApiModel(), "custom-api");
    assert.equal(resolveCliModel(), "custom-cli");
  } finally {
    if (saved.agent === undefined) delete process.env.CURSOR_AGENT;
    else process.env.CURSOR_AGENT = saved.agent;
    if (saved.api === undefined) delete process.env.MIRROR_AI_API_MODEL;
    else process.env.MIRROR_AI_API_MODEL = saved.api;
    if (saved.cli === undefined) delete process.env.MIRROR_AI_CLI_MODEL;
    else process.env.MIRROR_AI_CLI_MODEL = saved.cli;
    delete process.env.CURSOR_CONVERSATION_ID;
  }
});
