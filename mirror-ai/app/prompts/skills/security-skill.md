# security-skill — Security Analysis

Runs as part of the audit, on the same module and the same evidence. It adds the
**last** section of the report, after the API Contract Drift section.

This is a static review of the **pinned Android and iOS checkouts** for this
audit. It asks two questions for every security domain: is the control weak in
absolute terms, and do the two platforms differ. It does not run the app, probe
a server, or claim anything that only a runtime test could show.

**Never** paste findings from a previous report, another market, or a
pre-generated snapshot. Every row must come from outcome-based discovery in the
pinned checkouts (module scope or full market, as stated in the scope note).

## Objective

Report the security posture of this module on Android and on iOS, and where the
two differ. A control that exists on one platform and not the other is a
finding. A control that is weak on both is also a finding.

Analysis only. Do not fix either platform, do not write exploit steps or
payloads, and do not print real secrets (see Redaction).

## Boundaries with the other sections

- **Do not repeat the API skill.** Header and body drift, `CASE` drift such as
  `uid` / `UID`, and host drift belong in section 3. If a security finding
  depends on one of them, reference the API inventory row by path instead of
  re-reporting it.
- **Do not repeat the Business Logic matrix.** If a rule is enforced only on the
  client, report the security consequence here and cite the `BL-xx` ID that
  describes the rule.
- Which screens exist and what they contain belongs to the UI section. Only
  security-relevant screen behavior (screenshot protection, secure text entry)
  belongs here.

## Redaction

Never publish a full secret, token, key, password, certificate or card number.
Show the first four characters followed by `…`, plus the `path/File.kt:124`
citation. If a value is shorter than twelve characters, show only its kind
(`API key`, `password`) and the citation.

## Resolve the context first (never hard-code it)

Read these from the code, not from memory or another market's report:

1. **Market and tenant** — from the tenant config in each repository.
2. **Pinned commits** — from the module brief. Quote them in the meta table; do
   not invent them.
3. **Scope** — module or full market, as stated in the scope note. Some domains
   are app-wide (pinning, backup rules, hardening). Mark those `App-wide` in the
   findings table and report them once, not once per module.

## Scope split: module sections and the App-wide Security section

This skill is opt-in (`MIRROR_AI_SECURITY=1`). When it is on, a whole-project or
module audit gets this section in two places, and they must not overlap:

- **Every module** publishes section 4 for what *that module's code* does:
  domains 2 (how the module uses tokens and identifiers), 6, 7, 8, 9 and 10, and
  any module-specific use of storage or crypto. For an app-wide control
  (transport, pinning, backup rules, hardening, permissions, dependencies,
  hard-coded secrets outside this module), do **not** re-report it: write one
  line saying it is covered in the **App-wide Security** section. The module's
  Meta table may cite the layers it touches; write `see App-wide Security` for
  layers it does not.
- The **App-wide Security** section (module brief says so) is run once over the
  security layer files of the whole app: manifests, network and backup config,
  `Info.plist`, entitlements, build and obfuscation config, lockfiles, the
  network, storage, crypto, session, logging and hardening code. It publishes
  domains 1, 3, 4, 5, 11, 12 and 13 and the app-wide parts of 2 and 6, marks
  every finding `App-wide`, and owns the full **Control parity** and
  **Hard-coded secrets** tables. It has no Business Logic, UI or API section.

## Discovery (mandatory before any table)

Outcome-based discovery at the pinned commits. Do not assume file names; each
repository wires security differently. The names below are examples only.

For **each platform**, find and name the file for:

1. **Network security layer** — Android: `network_security_config.xml`, the
   OkHttp client and interceptors, any `CertificatePinner` or custom
   `TrustManager`. iOS: ATS keys in `Info.plist`, the `URLSession` delegate, any
   pinning or trust evaluation.
2. **Storage layer** — Android: Keystore, `EncryptedSharedPreferences`,
   DataStore, Room. iOS: Keychain wrapper, `UserDefaults`, Core Data or SQLite.
3. **Crypto helpers** — including the field-encryption path (for example the
   `digitalKey` flow) on both platforms.
4. **Platform manifests** — Android: `AndroidManifest.xml`. iOS: `Info.plist`,
   entitlements, associated domains.
5. **Release vs debug configuration** — build types and flavors, `*.xcconfig`,
   schemes, and anything gated on `BuildConfig.DEBUG` or `#if DEBUG`.
6. **Logging and analytics wrappers** — the code that decides what leaves the
   device or reaches the console.
7. **Session and auth owner** — what stores, refreshes and clears the token and
   user identifier, and what the logout path touches.

Then, for this module, trace every place it touches one of those layers:
tokens, identifiers, MSISDN, payment data, deep links, web views, file or
clipboard access.

### Discovery gates (do not publish if any fails)

| Gate | Fail if |
|------|---------|
| No template paste | A finding or control was copied from another market or an old report without re-reading this repository |
| Controls layers named | The network, storage or crypto layer is not named for each platform |
| Evidence present | A finding has no file citation on at least one platform it is claimed on |
| Cells explained | A platform cell is empty without `unverified — nearest: <file>` in the finding |
| Secrets redacted | Any full secret, token or key appears in the output |

## Security domains

Assess each domain on both platforms, then compare. Skip a domain only when the
module has no surface for it, and say so in *Not assessed*.

| # | Domain | What to check |
|---|--------|---------------|
| 1 | Transport security | Cleartext allowed; ATS exceptions; certificate pinning present or absent; custom trust managers; minimum TLS; debug trust bypass left in release |
| 2 | Authentication and session | Where tokens and user identifiers are stored; refresh and expiry handling; logout clearing every credential and cache; biometric or PIN gating; timeout after backgrounding |
| 3 | Secure storage | Sensitive values in `SharedPreferences` or `UserDefaults` instead of Keystore or Keychain; database encryption; Android `allowBackup` and `dataExtractionRules`; iCloud backup exclusion; Keychain accessibility class |
| 4 | Secrets and configuration | Hard-coded API keys, tokens, client secrets and encryption keys; staging, internal or test URLs reachable in release builds |
| 5 | Cryptography | Algorithm, mode and padding; IV or nonce reuse; key derivation; hard-coded keys; whether both platforms encrypt the same fields the same way |
| 6 | Sensitive data exposure | MSISDN, PII or payment data in logs (`Log.d`, `print`, `os_log`), analytics payloads, crash reports, clipboard, notifications; screenshot and app-switcher protection (`FLAG_SECURE` or its iOS equivalent) |
| 7 | Deep links and entry points | Exported activities, receivers and providers; intent filters; URL schemes and universal links; validation of redirection targets; whether a link can skip authentication or a journey step |
| 8 | WebView and embedded web | JavaScript enabled; JS bridges; URL allow-listing; file access; handling of third-party payment pages |
| 9 | Client-side trust | Eligibility, price or plan values enforced only on the client; identifiers such as MSISDN or account id taken from user-controlled input; rules the BFF must re-check |
| 10 | Payment and PII handling | What card or payment data touches the app; whether it is stored, logged or cached; which platform wires a third-party payment path the other lacks |
| 11 | Platform hardening | Root and jailbreak detection; debuggable flags; R8, ProGuard and symbol stripping; dev menus and feature-flag overrides in release; integrity checks |
| 12 | Permissions and privacy | Manifest permissions against `Info.plist` usage strings; location or device data sent in headers or bodies; data collected beyond what the module needs |
| 13 | Dependencies | Third-party SDKs and versions from lockfiles. Known-vulnerability status is `unverified` unless the repository itself establishes it |

## Classification

**Severity** — exactly one of:

| Value | Meaning |
|-------|---------|
| `Critical` | Direct exposure of credentials, payment data or accounts, or a bypass of authentication or authorization |
| `High` | Sensitive data stored or sent unprotected, or a missing control on one platform that protects sensitive flows on the other |
| `Medium` | Weakened control, or exposure that needs another condition to be exploited |
| `Low` | Hardening gap with limited impact |
| `Info` | Observation worth recording that is not a weakness |

**Confidence** — exactly one of `Confirmed`, `Potential`,
`Missing Implementation`, `Requirements Gap`, `Runtime Verification Required`.
Use the same meanings as the Business Logic matrix.

**MASVS area** — exactly one of `STORAGE`, `CRYPTO`, `AUTH`, `NETWORK`,
`PLATFORM`, `CODE`, `RESILIENCE`, `PRIVACY`. Add a CWE in the Impact cell only
where one clearly applies, for example `CWE-312`.

**Platform** — exactly one of `Android`, `iOS`, `Both`. One root cause is one
finding; do not publish it twice.

## Section to publish

### 4. Security Analysis

Open with one sentence stating that this is a static review of the pinned
checkouts, and that anything needing a running app or a server is listed under
*Not assessed*.

#### Meta

| | |
|---|---|
| **Market** | market and tenant, from code |
| **Scope** | module or full market, from the scope note |
| **Android** | branch @ short commit |
| **iOS** | branch @ short commit |
| **Network layer** | Android file · iOS file |
| **Storage layer** | Android file · iOS file |
| **Crypto layer** | Android file · iOS file |

#### Counts

| Platform | Critical | High | Medium | Low | Info |
|----------|----------|------|--------|-----|------|

One row for Android, one for iOS. A `Both` finding counts on each platform.
Integers only. Do not compute, estimate or state any percentage anywhere in this
section; the reader's page computes them.

#### Security findings

| ID | Rule | Domain | MASVS | Platform | Android Behavior | iOS Behavior | Impact | Severity | Confidence |
|----|------|--------|-------|----------|------------------|--------------|--------|----------|------------|

- **ID** — `SEC-01`, `SEC-02`, in order.
- **Rule** — the ID of the security rule whose root cause this is (for example
  `SR-CRYPTO-001`), from the *Security rules* list appended to this skill, or
  `NEW` when no rule fits. Use exactly one ID. Never pick a rule because a past
  ticket or report mentions it; the cited code must show its root cause. Two
  rows with the same Rule and the same cited location are one finding.
- **Domain** — the domain name from the table above. Add `App-wide` after it
  where the finding is not specific to this module.
- **Android Behavior** / **iOS Behavior** — what the platform actually does, in
  one or two sentences, each ending with the `path/File.kt:124-129` that shows
  it. If a platform has no such control, say so. If it cannot be resolved, write
  `unverified — nearest: <file>`.
- **Impact** — the consequence for a user, an account or a transaction. If there
  is none, the row does not belong here.
- Order rows by severity, `Critical` first, then by confidence.

Keep every cell to one line. No line breaks, no bullets, no nested tables inside
cells. Write *None.* instead of the table when there are no findings.

#### Control parity

| Control | Android | iOS | Status |
|---------|---------|-----|--------|

List **only** controls where **Status** is not `Same`. **Status** is exactly one
of `Drift`, `Android only`, `iOS only`. Check at least these controls:
certificate pinning, secure token storage, screenshot and app-switcher
protection, root or jailbreak detection, backup exclusion, log redaction,
biometric gating, deep-link validation, field encryption. Each platform cell is
a few words with a citation, or `—` when the platform has nothing. Write
*Security controls match on both platforms.* when nothing differs.

#### Hard-coded secrets

| ID | Platform | Kind | Redacted value | Citation |
|----|----------|------|----------------|----------|

- **ID** — `SECRET-01`, in order.
- **Kind** — `API key`, `token`, `client secret`, `encryption key`, `password`,
  `internal URL`.
- **Redacted value** — per the Redaction rule above.

Write *None.* when nothing is found in the code read.

#### Proposed rules

One row for each `NEW` finding whose root cause could recur in other code or
other apps. This is how the rules knowledge base learns; a person reviews every
row before it becomes a rule.

| ID | Proposed name | Category | Findings | Evidence | Closest existing rule |
|----|---------------|----------|----------|----------|-----------------------|

- **ID** — `PROPOSED-01`, in order.
- **Proposed name** — the root cause in a few words, not the symptom.
- **Findings** — the `SEC-xx` IDs in this section that it covers.
- **Evidence** — at least one `path/File.kt:124` citation from the pinned
  checkouts. A row without one is dropped.
- **Closest existing rule** — the nearest `SR-…` ID and what it is missing, or
  `none`.

Write *None.* when every finding maps to an existing rule.

#### Not assessed

One line each, for anything static reading could not settle and anything outside
the scope note: runtime pinning behavior, server-side enforcement, dependency
vulnerability status, jailbreak or root behavior on a device. This list exists so
the report is never read as full coverage.

## Strict constraints

- Analysis only. Do not modify files, create commits or change configuration.
- Everything the main spec says about evidence applies here: cite real paths and
  lines, never invent a control, finding, endpoint or line number, and where
  static reading cannot settle a cell, write `unverified` instead of guessing.
- Do not claim full coverage when code remains uninspected.
- Do not publish exploit steps, payloads or full secrets.
- Do not duplicate findings from sections 1 to 3; reference their IDs instead.
- If the module has no security-relevant surface on either platform, write one
  sentence saying so and publish no tables.
