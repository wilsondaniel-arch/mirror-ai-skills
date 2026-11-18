import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { auditPasses, passSpec, type AuditRequest } from "../src/audit.ts";
import { summarizeReport } from "../src/report-summary.ts";
import { renderReportUi } from "../src/report-ui.ts";
import { SECURITY_SKILL } from "../src/security-scope.ts";
import {
  BUNDLED_SECURITY_RULES,
  extractProposedRules,
  loadSecurityRules,
  parseSecurityRules,
  renderProposals,
  RULE_ID,
  securityRulesPrompt,
  unknownRuleIds,
} from "../src/security-rules.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundled = readFileSync(path.join(root, BUNDLED_SECURITY_RULES), "utf8");

/** Runs `fn` with the given env values set (undefined = unset), then restores them. */
function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    before[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const request = (): AuditRequest => ({ androidPath: "", iosPath: "", rows: [], defs: [], projectRoot: root, mode: "module" });

test("every bundled rule has a unique permanent ID and all twelve fields", () => {
  const rules = parseSecurityRules(bundled);
  assert.ok(rules.length >= 20, `expected the knowledge base, got ${rules.length} rules`);
  const ids = rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, "rule IDs are unique");
  for (const rule of rules) {
    assert.match(rule.id, RULE_ID);
    assert.ok(rule.name && rule.category && rule.severity && rule.platforms, `${rule.id} metadata`);
    assert.ok(rule.detection.length > 40, `${rule.id} has detection logic`);
    assert.ok(rule.falsePositives.length > 0, `${rule.id} has false positive notes`);
    // Traceability: every rule names where it came from.
    assert.match(rule.reference, /VULN-\d+|R-[A-Z]+-\d+/, `${rule.id} has a reference`);
  }
  // Each rule block carries every section of the format, in the documented order.
  const blocks = bundled.split(/^### (?=SR-)/m).slice(1);
  assert.equal(blocks.length, rules.length);
  const order = ["Rule ID", "Rule Name", "Security Category", "Severity", "Affected Platforms", "Reference", "#### Description", "#### Root Cause", "#### Detection Logic", "#### Vulnerable Code Examples", "#### Recommended Secure Implementation", "#### False Positive Considerations"];
  for (const block of blocks) {
    let at = -1;
    for (const field of order) {
      const next = block.indexOf(field, at + 1);
      assert.ok(next > at, `${block.slice(0, 14)} has ${field} in order`);
      at = next;
    }
  }
});

test("the rules never print a real secret", () => {
  assert.doesNotMatch(bundled, /AIza[0-9A-Za-z_-]{20,}/, "no full Google API key");
  assert.doesNotMatch(bundled, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, "no private key");
});

test("MIRROR_AI_SECURITY_RULES wins over the bundled copy, and a broken file falls back", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rules-"));
  const custom = path.join(dir, "security-rules.md");
  writeFileSync(
    custom,
    [
      "### SR-TEST-001 — Test rule",
      "",
      "- **Rule ID:** SR-TEST-001",
      "- **Rule Name:** Test rule",
      "- **Security Category:** Test",
      "- **Severity:** Low",
      "- **Affected Platforms:** Android",
      "- **Reference:** VULN-1",
      "",
      "#### Detection Logic",
      "Look for `dangerous()`.",
      "",
      "#### False Positive Considerations",
      "Tests.",
    ].join("\n"),
  );
  withEnv({ MIRROR_AI_SECURITY_RULES: custom, MIRROR_AI_SECURITY_RULES_SOURCE: "superapp-workspace docs/security-rules.md @ main abc1234" }, () => {
    const loaded = loadSecurityRules(root);
    assert.deepEqual(loaded.rules.map((rule) => rule.id), ["SR-TEST-001"]);
    assert.equal(loaded.source, "superapp-workspace docs/security-rules.md @ main abc1234");
  });
  writeFileSync(custom, "# not a rules file\n");
  withEnv({ MIRROR_AI_SECURITY_RULES: custom, MIRROR_AI_SECURITY_RULES_SOURCE: undefined }, () => {
    const loaded = loadSecurityRules(root);
    assert.match(loaded.source, /^bundled /);
    assert.ok(loaded.rules.length >= 20);
  });
  withEnv({ MIRROR_AI_SECURITY_RULES: path.join(dir, "missing.md") }, () => assert.match(loadSecurityRules(root).source, /^bundled /));
});

test("retired rules stay in the file but are not sent to the model", () => {
  const text = bundled.replace("- **Rule ID:** SR-RES-004", "- **Rule ID:** SR-RES-004\n- **Status:** Retired");
  const loaded = { rules: parseSecurityRules(text), source: "test" };
  assert.ok(loaded.rules.some((rule) => rule.id === "SR-RES-004"));
  assert.doesNotMatch(securityRulesPrompt(loaded), /SR-RES-004/);
});

test("the security pass carries the rules; the other passes do not change", () => {
  withEnv({ MIRROR_AI_SECURITY: "1", MIRROR_AI_SECURITY_RULES: undefined }, () => {
    const passes = auditPasses(root);
    const security = passes.find((pass) => pass.id === SECURITY_SKILL)!;
    const spec = passSpec(request(), security);
    assert.match(spec, /# Security rules \(knowledge base\)/);
    assert.match(spec, /Rules source: bundled prompts\/references\/security-rules\.md/);
    assert.match(spec, /\*\*SR-CRYPTO-001\*\*/);
    assert.match(spec, /`NEW`/);
    // The skill asks for the Rule column and the Proposed rules table.
    assert.match(security.spec, /\| ID \| Rule \| Domain \|/);
    assert.match(security.spec, /#### Proposed rules/);
    for (const pass of passes.filter((item) => item.id !== SECURITY_SKILL && item.id !== "api-skill")) {
      assert.equal(passSpec(request(), pass), pass.spec, `${pass.id} unchanged`);
      assert.doesNotMatch(passSpec(request(), pass), /Security rules \(knowledge base\)/);
    }
  });
});

test("the workflow is market-neutral: no market's findings are hard-coded in code or the skill", () => {
  for (const file of ["src/security-rules.ts", "src/security-scope.ts", "prompts/skills/security-skill.md", "scripts/ark-audit.sh"]) {
    assert.doesNotMatch(readFileSync(path.join(root, file), "utf8"), /panama|VULN-\d+/i, file);
  }
});

const RULED_REPORT = `# Business logic audit — Auto Logout

### 1. Business Logic Difference Matrix

| ID | Area | Android | iOS | Impact | Severity | Confidence |
|---|---|---|---|---|---|---|
| BL-01 | Timer | a \`LogoutSession.kt:10\` | b \`InactivityManager.swift:4\` | logout late | Medium | Confirmed |

### 4. Security Analysis

#### Security findings

| ID | Rule | Domain | MASVS | Platform | Android Behavior | iOS Behavior | Impact | Severity | Confidence |
|----|------|--------|-------|----------|------------------|--------------|--------|----------|------------|
| SEC-01 | SR-AUTH-002 | Authentication and session | AUTH | Android | Token kept after logout \`app/src/main/java/x/LogoutSession.kt:40\` | Cleared \`App/Core/Session.swift:12\` | Session reuse | High | Confirmed |
| SEC-02 | SR-CRYPTO-003 | Cryptography | CRYPTO | Android | Reuses the IV \`core/security/AESTool.kt:120\` | — | Token exposure | High | Confirmed |
| SEC-03 | NEW | Sensitive data exposure | PRIVACY | Android | Writes the MSISDN to the clipboard \`app/src/main/java/x/Copy.kt:9\` | — | PII exposure | Medium | Potential |

#### Proposed rules

| ID | Proposed name | Category | Findings | Evidence | Closest existing rule |
|----|---------------|----------|----------|----------|-----------------------|
| PROPOSED-01 | Personal data copied to the clipboard | Sensitive data exposure | SEC-03 | \`app/src/main/java/x/Copy.kt:9\` | SR-DATA-001 covers analytics, not the clipboard |
| PROPOSED-02 | Something without evidence | Other | SEC-03 | no citation | none |
| PROPOSED-03 | SR-CRYPTO-003 | Cryptography | SEC-02 | \`core/security/AESTool.kt:120\` | — |

---

# Business logic audit — App-wide Security

### 4. Security Analysis

#### Security findings

| ID | Rule | Domain | MASVS | Platform | Android Behavior | iOS Behavior | Impact | Severity | Confidence |
|----|------|--------|-------|----------|------------------|--------------|--------|----------|------------|
| SEC-01 | SR-CRYPTO-003 | Cryptography App-wide | CRYPTO | Android | One IV for every call \`core/security/AESTool.kt:120\` | — | Token exposure | High | Confirmed |

#### Proposed rules

| ID | Proposed name | Category | Findings | Evidence | Closest existing rule |
|----|---------------|----------|----------|----------|-----------------------|
| PROPOSED-01 | Personal data copied to the clipboard! | Sensitive data exposure | SEC-09 | \`App/Copy.swift:3\` | none |
`;

test("a report with the Rule column: rules are read by header, and a repeated root cause counts once", () => {
  const summary = summarizeReport(RULED_REPORT);
  const module = summary.modules.find((item) => item.label === "Auto Logout")!;
  const findings = module.security!.findings;
  assert.deepEqual(findings.map((item) => item.rule), ["SR-AUTH-002", "SR-CRYPTO-003", "NEW"]);
  // Columns after Rule are not shifted.
  assert.equal(findings[0].domain, "Authentication and session");
  assert.equal(findings[0].masvs, "AUTH");
  assert.equal(findings[0].platform, "Android");
  assert.ok(findings[0].files.includes("app/src/main/java/x/LogoutSession.kt"));
  // The module's SEC-02 repeats the App-wide SEC-01 (same rule, same file): App-wide keeps it.
  assert.equal(findings[1].duplicateOf, "App-wide Security SEC-01");
  const appWide = summary.modules.find((item) => item.label === "App-wide Security")!;
  assert.equal(appWide.security!.findings[0].duplicateOf, undefined);
  // Module counts still show what the module's section says; the run total counts the root cause once.
  assert.equal(module.security!.counts.high, 2);
  assert.equal(summary.securityTotals!.high, 2);
  assert.equal(summary.securityDuplicates, 1);
  assert.deepEqual(summary.securityRules, [
    { rule: "NEW", findings: ["Auto Logout SEC-03"] },
    { rule: "SR-AUTH-002", findings: ["Auto Logout SEC-01"] },
    { rule: "SR-CRYPTO-003", findings: ["App-wide Security SEC-01", "Auto Logout SEC-02"] },
  ]);
});

test("a report without the Rule column keeps the original summary shape", () => {
  // The same report as written before the Rule column: drop the second cell of every 10-column row.
  const legacy = RULED_REPORT.split("\n")
    .map((line) => {
      const parts = line.split("|");
      return parts.length === 12 ? [...parts.slice(0, 2), ...parts.slice(3)].join("|") : line;
    })
    .join("\n");
  assert.doesNotMatch(legacy, /\| Rule \||SR-AUTH-002/);
  const summary = summarizeReport(legacy);
  const module = summary.modules.find((item) => item.label === "Auto Logout")!;
  assert.equal(module.security!.findings[0].domain, "Authentication and session");
  assert.equal(module.security!.findings[0].rule, undefined);
  assert.equal(summary.securityRules, undefined);
  assert.equal(summary.securityDuplicates, undefined);
  assert.equal(summary.securityTotals!.high, 3, "no rule, so nothing is merged");
});

test("the HTML report shows the rule on each security card", () => {
  const { html } = renderReportUi(RULED_REPORT);
  assert.match(html, /title="Security rule">SR-AUTH-002</);
  assert.match(html, /title="Security rule">NEW</);
  assert.match(html, /Proposed rules/);
});

test("proposed rules need a code citation, never reuse a rule ID, and are not repeated", () => {
  const known = parseSecurityRules(bundled);
  const proposals = extractProposedRules(RULED_REPORT, known);
  assert.deepEqual(proposals.map((item) => item.name), ["Personal data copied to the clipboard"]);
  assert.equal(proposals[0].module, "Auto Logout");
  assert.equal(proposals[0].findings, "SEC-03");
  assert.match(proposals[0].closest, /SR-DATA-001/);
  const text = renderProposals(proposals, "bundled prompts/references/security-rules.md", "Caribbean-ALL-SEC-2026-11-18");
  assert.match(text, /^# Proposed security rules/);
  assert.match(text, /From Caribbean-ALL-SEC-2026-11-18\. Rules in force for this run: bundled/);
  assert.match(text, /None is\s+validated/);
  assert.equal(renderProposals([], "x", "y"), "");
});

test("rule headings and fields are read in their common spellings, so no rule is dropped", () => {
  const text = [
    "### SR-NET-004: Colon heading",
    "- **Severity**: High",
    "- **Affected Platforms:** Android",
    "Status: Retired",
    "#### Detection Logic",
    "x",
    "### SR-WEB2-1000 - Digits in the area and a long number",
    "- **Rule Name:** Long",
    "#### Detection Logic",
    "y",
  ].join("\n");
  const rules = parseSecurityRules(text);
  assert.deepEqual(rules.map((rule) => rule.id), ["SR-NET-004", "SR-WEB2-1000"]);
  assert.equal(rules[0].severity, "High");
  assert.equal(rules[0].status, "Retired");
  assert.ok(rules.every((rule) => RULE_ID.test(rule.id)));
});

test("server-only rules are named once, not sent as app checks, and nothing is cut short", () => {
  const prompt = securityRulesPrompt({ rules: parseSecurityRules(bundled), source: "test" });
  assert.doesNotMatch(prompt, /\*\*SR-SRV-001\*\*/);
  assert.match(prompt, /Server-side only.*SR-SRV-001/);
  // No field is cut short: the end of every app rule's detection logic and false-positive note reaches the prompt.
  const tail = (text: string) => text.replace(/```[\s\S]*?```/g, " ").replace(/^\s*[-*]\s+/gm, "").replace(/\s+/g, " ").trim().slice(-30);
  for (const rule of parseSecurityRules(bundled).filter((item) => item.id !== "SR-SRV-001")) {
    assert.ok(prompt.includes(tail(rule.detection)), `${rule.id} detection complete`);
    assert.ok(prompt.includes(tail(rule.falsePositives)), `${rule.id} false positives complete`);
  }
});

test("an escaped pipe in a cell keeps the proposal; rule IDs and existing rule names are never proposed", () => {
  const known = parseSecurityRules(bundled);
  const report = [
    "# Business logic audit — Login",
    "#### Proposed rules",
    "| ID | Proposed name | Category | Findings | Evidence | Closest existing rule |",
    "|---|---|---|---|---|---|",
    "| PROPOSED-01 | Debug overlay \\| on live data | Hardening | SEC-01 | `A.kt:10` | none |",
    "| PROPOSED-02 | Lockfile pins a vulnerable SDK | Dependencies | SEC-02 | `Podfile.lock:40` | none |",
    "| SR-CRYPTO-001 | Something | Crypto | SEC-03 | `B.kt:1` | — |",
    "| PROPOSED-04 | SR-CRYPTO-001 (extended) | Crypto | SEC-03 | `B.kt:1` | — |",
    "| PROPOSED-05 | AES in ECB mode for payload or field encryption | Crypto | SEC-03 | `B.kt:1` | — |",
  ].join("\n");
  assert.deepEqual(extractProposedRules(report, known).map((item) => item.name), ["Debug overlay | on live data", "Lockfile pins a vulnerable SDK"]);
});

test("a Rule ID the rules file does not define is listed for review", () => {
  const ids = parseSecurityRules(bundled).map((rule) => rule.id);
  const report = RULED_REPORT.replace("| SEC-01 | SR-AUTH-002 |", "| SEC-01 | SR-STORAGE-002 |");
  assert.deepEqual(unknownRuleIds(report, ids), ["Auto Logout SEC-01: SR-STORAGE-002"]);
  assert.match(renderProposals([], "x", "y", unknownRuleIds(report, ids)), /Rule IDs not in the rules file[\s\S]*SR-STORAGE-002/);
});

test("the same rule at another line of the same file is a different finding", () => {
  const report = RULED_REPORT.replace("Reuses the IV `core/security/AESTool.kt:120`", "Reuses the IV `core/security/AESTool.kt:200`");
  const summary = summarizeReport(report);
  assert.equal(summary.securityDuplicates, 0);
  assert.equal(summary.securityTotals!.high, 3);
});
