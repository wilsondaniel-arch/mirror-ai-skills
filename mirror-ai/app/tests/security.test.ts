import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { auditPasses, readSkills } from "../src/audit.ts";
import { rankSide } from "../src/budget-audit.ts";
import { summarizeReport } from "../src/report-summary.ts";
import { renderReportUi } from "../src/report-ui.ts";
import { reportFolderName } from "../src/reports-home.ts";
import { clearSourceCache } from "../src/scan.ts";
import {
  isSecurityDef,
  passesFor,
  SECURITY_MODULE_ID,
  SECURITY_SKILL,
  securityBaselineDef,
  securityEnabled,
  securityScore,
} from "../src/security-scope.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Runs `fn` with MIRROR_AI_SECURITY set to `value` (or unset), then restores it. */
function withSecurity<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.MIRROR_AI_SECURITY;
  if (value === undefined) delete process.env.MIRROR_AI_SECURITY;
  else process.env.MIRROR_AI_SECURITY = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.MIRROR_AI_SECURITY;
    else process.env.MIRROR_AI_SECURITY = before;
  }
}

function writeTree(base: string, files: Record<string, string>): string {
  for (const [relative, text] of Object.entries(files)) {
    const full = path.join(base, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return base;
}

test("the security skill is off by default, so existing audits keep their passes", () => {
  withSecurity(undefined, () => {
    assert.equal(securityEnabled(), false);
    assert.ok(!readSkills(root).some((skill) => skill.name === SECURITY_SKILL));
    assert.ok(!auditPasses(root).some((pass) => pass.id === SECURITY_SKILL));
  });
  withSecurity("0", () => assert.equal(securityEnabled(), false));
});

test("MIRROR_AI_SECURITY=1 adds section 4 after the API section", () => {
  withSecurity("1", () => {
    const passes = auditPasses(root);
    const ids = passes.map((pass) => pass.id);
    assert.ok(ids.includes(SECURITY_SKILL), `expected ${SECURITY_SKILL}, got ${ids.join(", ")}`);
    assert.equal(ids.at(-1), SECURITY_SKILL, "section 4 sorts last");
    const security = passes.find((pass) => pass.id === SECURITY_SKILL)!;
    assert.equal(security.firstHeading, "### 4. Security Analysis");
    assert.match(security.spec, /Scope split/);
  });
});

test("the App-wide Security section runs only the security pass", () => {
  const passes = [{ id: "logic" }, { id: "ui-skill" }, { id: "api-skill" }, { id: SECURITY_SKILL }];
  assert.deepEqual(passesFor({ id: SECURITY_MODULE_ID }, passes).map((p) => p.id), [SECURITY_SKILL]);
  assert.equal(passesFor({ id: "auto_logout" }, passes).length, 4);
  assert.ok(isSecurityDef({ id: SECURITY_MODULE_ID }));
});

test("the App-wide Security section reads config files first, then security code, never tests", () => {
  const android = writeTree(mkdtempSync(path.join(tmpdir(), "sec-android-")), {
    "app/src/main/AndroidManifest.xml": '<manifest><application android:allowBackup="true" android:usesCleartextTraffic="true"/></manifest>',
    "app/src/main/res/xml/network_security_config.xml": "<network-security-config/>",
    "app/proguard-rules.pro": "-keep class x.**",
    "app/src/main/java/com/x/network/NetworkModule.kt":
      "val c = OkHttpClient.Builder().certificatePinner(CertificatePinner.Builder().build()).addInterceptor(HttpLoggingInterceptor())",
    "app/src/main/java/com/x/home/HomeScreen.kt": "fun Home() { Text(\"hi\") }",
    "app/src/test/java/com/x/network/NetworkModuleTest.kt": "OkHttpClient.Builder() CertificatePinner",
  });
  const ios = writeTree(mkdtempSync(path.join(tmpdir(), "sec-ios-")), {
    "App/Info.plist": "<plist><dict><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict></plist>",
    "App/App.entitlements": "<plist/>",
    "App/Core/KeychainHelper.swift": "let q = [kSecClass: kSecClassGenericPassword, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock]; SecItemAdd(q as CFDictionary, nil)",
    "App/Views/HomeView.swift": "struct HomeView: View { var body: some View { Text(\"hi\") } }",
  });
  clearSourceCache();
  const def = securityBaselineDef(android, ios);
  assert.ok(def);
  assert.equal(def.id, SECURITY_MODULE_ID);
  assert.equal(def.ordered, true);
  const a = def.files!.android;
  assert.deepEqual(a.slice(0, 3).sort(), ["app/proguard-rules.pro", "app/src/main/AndroidManifest.xml", "app/src/main/res/xml/network_security_config.xml"]);
  assert.ok(a.includes("app/src/main/java/com/x/network/NetworkModule.kt"));
  assert.ok(!a.some((file) => /HomeScreen|Test\.kt/.test(file)), `no screen or test file: ${a.join(", ")}`);
  const i = def.files!.ios;
  assert.ok(i.includes("App/Info.plist") && i.includes("App/App.entitlements") && i.includes("App/Core/KeychainHelper.swift"));
  assert.ok(!i.includes("App/Views/HomeView.swift"));

  // The budget runner reads the manifest even though it is not a code source.
  const side = rankSide("Android", android, [], a, true);
  assert.equal(side.files[0].source.relativePath, a[0]);
  assert.ok(side.files.some((file) => file.source.relativePath.endsWith("AndroidManifest.xml") && /allowBackup/.test(file.body)));
});

test("security score counts distinct signals, plus a bonus for a security-named file", () => {
  assert.equal(securityScore({ relativePath: "a/HomeScreen.kt", text: "fun x() = 1" }), 0);
  assert.ok(securityScore({ relativePath: "a/TokenStore.kt", text: "EncryptedSharedPreferences.create(MasterKey)" }) >= 3);
});

const SECURITY_REPORT = `# Business logic audit — Auto Logout

### 1. Business Logic Difference Matrix

| ID | Area | Android | iOS | Impact | Severity | Confidence |
|---|---|---|---|---|---|---|
| BL-01 | Timer | a \`LogoutSession.kt:10\` | b \`InactivityManager.swift:4\` | logout late | Medium | Confirmed |

### 4. Security Analysis

This is a static review of the pinned checkouts.

#### Security findings

| ID | Domain | MASVS | Platform | Android Behavior | iOS Behavior | Impact | Severity | Confidence |
|----|--------|-------|----------|------------------|--------------|--------|----------|------------|
| SEC-01 | Authentication and session | AUTH | Both | Token kept after logout \`app/src/main/java/x/LogoutSession.kt:40\` | Same \`Panama/Core/Session.swift:12\` | Session reuse | Critical | Confirmed |
| SEC-02 | Sensitive data exposure | PRIVACY | Android | MSISDN logged \`app/src/main/java/x/Repo.kt:9\` | unverified — nearest: \`Panama/Core/Log.swift\` | PII in logs | High | Potential |

#### Control parity

| Control | Android | iOS | Status |
|---------|---------|-----|--------|
| Screenshot protection | FLAG_SECURE \`MainActivity.kt:20\` | — | Android only |

#### Hard-coded secrets

| ID | Platform | Kind | Redacted value | Citation |
|----|----------|------|----------------|----------|
| SECRET-01 | iOS | API key | AIza… | \`Panama/Info.plist:30\` |

---

# Business logic audit — App-wide Security

### 4. Security Analysis

#### Security findings

| ID | Domain | MASVS | Platform | Android Behavior | iOS Behavior | Impact | Severity | Confidence |
|----|--------|-------|----------|------------------|--------------|--------|----------|------------|
| SEC-01 | Transport security App-wide | NETWORK | iOS | Pinned \`app/src/main/AndroidManifest.xml:5\` | ATS off \`Panama/Info.plist:12\` | MITM on iOS | High | Confirmed |
`;

test("summary.json gets security counts apart from the parity score", () => {
  const summary = summarizeReport(SECURITY_REPORT);
  const module = summary.modules.find((item) => item.label === "Auto Logout")!;
  assert.ok(module.security);
  assert.deepEqual(module.security.counts, { critical: 1, high: 1, medium: 0, low: 0, info: 0, secrets: 1, parityGaps: 1 });
  assert.equal(module.security.findings[0].id, "SEC-01");
  assert.ok(module.security.findings[0].files.includes("app/src/main/java/x/LogoutSession.kt"));
  // The BL matrix still decides the parity counts; security never adds to them.
  assert.equal(module.counts.high, 0);
  assert.equal(module.counts.medium, 1);
  // A Critical security finding turns the module red.
  assert.equal(module.status, "red");

  const appWide = summary.modules.find((item) => item.label === "App-wide Security")!;
  assert.equal(appWide.score, null, "no parity matrix to score");
  assert.equal(appWide.status, "amber");
  assert.equal(appWide.security!.findings[0].appWide, true);
  assert.ok(appWide.security!.findings[0].files.includes("Panama/Info.plist"));
  // The parity score is the mean over real modules only.
  assert.equal(summary.score, module.score);
  assert.deepEqual(summary.securityTotals, { critical: 1, high: 2, medium: 0, low: 0, info: 0, secrets: 1, parityGaps: 1 });
});

test("a report without a security section summarises exactly as before", () => {
  const plain = SECURITY_REPORT.split("### 4. Security Analysis")[0];
  const summary = summarizeReport(plain);
  assert.equal(summary.securityTotals, undefined);
  assert.equal(summary.modules[0].security, undefined);
  assert.ok(!("security" in summary.modules[0]));
});

test("the HTML report has a Security tab with one card per finding", () => {
  const { html } = renderReportUi(SECURITY_REPORT);
  assert.match(html, /data-key="sec"/);
  assert.match(html, />Security </);
  assert.match(html, /id="sec-autologout-sec"/);
  assert.match(html, /SEC-01/);
  assert.match(html, /Hard-coded secrets/);
  assert.match(html, /AIza…/);
  assert.match(html, /App-wide Security/);
});

test("a security run publishes to its own folder", () => {
  const date = "2026-11-17T06:00:00.000Z";
  assert.equal(reportFolderName("panama", { scope: "project", date }), "Panama-ALL-2026-11-17");
  assert.equal(reportFolderName("panama", { scope: "project", date, security: true }), "Panama-ALL-SEC-2026-11-17");
  assert.equal(reportFolderName("panama", { scope: "modules", modules: ["AUTO_LOGOUT"], date, security: true }), "Panama-AUTO_LOGOUT-SEC-2026-11-17");
});
