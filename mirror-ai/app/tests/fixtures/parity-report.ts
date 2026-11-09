/** A small parity report in the exact shape the audit writes: three modules, one failed, plus Miscellaneous. */
export const REPORT_A = `# Business logic audit — Awards

### 1. Business Logic Difference Matrix

| ID | Business Area | Android Behavior | iOS Behavior | Business Impact | Severity | Confidence |
|---|---|---|---|---|---|---|
| BL-01 | B2B user AWARDS entry | no B2B branch (\`designsystem/nav/NavKeyMapper.kt:74-79\`). | B2B restricted (\`LLA-SuperApp-iOS/Core/RedirectionTarget.swift:203-213\`). | B2B users differ. | High | Potential |
| BL-02 | Fallback when CTA is missing | re-resolved (\`designsystem/nav/NavKeyMapper.kt:33-35\`). | target only. | CMS items differ. | Medium | Confirmed |
| BL-03 | Destination naming | FlowLoyaltyProgramRoute. | loyaltyHome. | Likely same. | Low | Requirements Gap |

> **Budget audit coverage** — claude-haiku-5-5 scanned 3/3 matching Android and 5/5 matching iOS source files (tests excluded) and proposed 8 candidate(s). Every matching file was read.

### 2. UI Difference

| Slot | Type | Android | iOS | State |
|---|---|---|---|---|
| Deactivate link | link | Shown when active | Always shown | divergent |
| Title | text | Awards | Awards | matched |

### Hard-coded copy on buttons and labels

3 user-visible string(s) are written as literals in code — Android only 1, iOS only 2, both 0.

### 3. API Contract Drift

#### High-risk findings

| Path | Contract | What to check | Drift |
|------|----------|---------------|-------|
| \`initiateBillPayment\` | Drift | android only third-party (PaymentService.kt:176) | \`ROUTE\` |

#### API inventory

| Path | Contract | Drift | Android extra | iOS extra | Android body | iOS body | Notes |
|------|----------|-------|---------------|-----------|--------------|----------|-------|
| \`list-recurring\` | **Same** | — | x | y | a | b | ok |
| \`initiate\` | **Drift** | \`BODY\` | x | y | a | b | differs |

#### Stale constants

None.

---

# Business logic audit — Bill payment

### 1. Business Logic Difference Matrix

**This section could not be produced.** The scan failed (usage limit).

### 2. UI Difference

**This section could not be produced.** The scan failed (usage limit).

---

# Business logic audit — Miscellaneous

### 1. Business Logic Difference Matrix

| ID | Business Area | Android Behavior | iOS Behavior | Business Impact | Severity | Confidence |
|---|---|---|---|---|---|---|
| BL-01 | Orphan screen | exists (\`app/src/main/java/com/x/Orphan.kt:10\`). | none | only Android. | High | Confirmed |
`;
