# api-skill — API Contract Drift

Runs as part of the audit, on the same module and the same evidence. It adds the
**last** section of the report, after the UI Difference.

Ported from the superapp-workspace API contract drift workflow
(`docs/10-api-contract-drift.md`, branches `feature/api-contract-drift` /
`feature/api-contract-drift-v2`). The full workflow text is appended to this
skill at runtime. Same contract values, drift tags, column sets and gates.

**Never** paste inventory from a pre-generated market report, canvas, or Mirror
AI `reference/` snapshot. Every row must come from outcome-based discovery in
the **pinned Android and iOS checkouts** for this audit (module scope or full
market, as stated in the scope note).

## Objective

For every BFF call this module makes, decide whether Android and iOS send the
**same request contract**: same relative path, same body, same headers, same
host. Same type name is not the same contract — read what is actually sent.

## Resolve the market first (never hard-code it)

Read it from the code, not from memory or another market's report:

1. **Market and tenant** — from the tenant config in each repository
   (`Tenants.kt`, flavor `buildConfigField`, `TenantConfig`, …).
2. **Pinned commits** — the module brief gives each checkout's branch and
   commit. Quote them in the meta table; do not invent them.
3. **Base URL and BFF prefix** — read each platform's config. Android: typically
   `build.gradle.kts` `BASE_URL`, `Tenants.kt`, flavor `buildConfigField`,
   `NetworkModule`. iOS: `NetworkConstants.swift`, `*.xcconfig`
   `API_BASE_URL`, `Environments.swift`. Prefixes differ by market (e.g.
   `/api/lla_app_bff/v1/` vs `/api/metac-app-bff/v1/`) — discover, never copy.

## Discovery (mandatory before any table)

Outcome-based discovery at the pinned commits. **Do not** assume `@Header`,
`*Request.kt`, `*Request.swift`, `HTTPHeaders.swift` or any Jamaica file name —
each repository wires HTTP differently. Those names are examples only.

For **each platform**:

1. **Find the HTTP entry layer** — BFF prefix, path constants (`EndPoints`,
   `NetworkConstants`, `*EndPoint.swift`, …), Retrofit interfaces, API clients,
   `URLRequest` builders.
2. **Find the baseline** — every header added globally: interceptors,
   middleware, default client config. Name the file for each platform.
3. **Enumerate this module's wired paths** — every BFF path the module reaches,
   directly or through a repository, use case or service. A constant with no
   caller is not wired; it goes in Stale constants.
4. **Trace one hop back for each path** — to what builds the body (DTO, encoder,
   map) and to any per-call header (annotation, `HeaderMap`, builder,
   per-request config).
5. **Record evidence** — cite `path/File.kt:124`. If a body or extra header
   cannot be resolved, write `unverified — nearest: <file>` in Notes; never
   leave a cell silently empty.

### Discovery gates (do not publish if any fails)

| Gate | Fail if |
|------|---------|
| No template paste | A row or the baseline was copied from another market or an old report without re-reading this repository |
| Inventory sourced | A path has no file evidence on at least one platform it is claimed on |
| Baseline identified | The global header layer is not named for each platform |
| Columns explained | A body or extra column is empty without `unverified` in Notes |

## What to compare

1. **Body** — field names, types, nullability; type renames on the same path.
2. **Headers** — beyond this market's baseline (`lob`, `countryCode`,
   `uid`/`UID`, location in header vs body, …).
3. **Route** — path wired on one platform only, or a different orchestration
   for the same journey (one combined call vs a chain).
4. **Host / base URL** — same path, different root URL.
5. **Wiring** — service integrated vs stale constant.

## Contract values

Spell them exactly like this:

| Value | Meaning |
|-------|---------|
| **Same** | Wired on both; request contract matches |
| **Drift** | Wired on both; body, headers, types, or orchestration differ |
| **Android only** | Wired on Android, absent on iOS |
| **iOS only** | Wired on iOS, absent on Android |

## Drift tags

One or more per row, in backticks, comma-separated; `—` when none:

| Tag | Meaning |
|-----|---------|
| `BODY` | Request body field mismatch |
| `HDR` | Per-call or baseline header mismatch |
| `ROUTE` | Path wired on one platform only, or a different call chain |
| `TYPE` | Type / enum mismatch on a shared path |
| `CASE` | Header name casing mismatch (e.g. `uid` vs `UID`) |
| `HOST` | Different base URL / host |

A **Same** row may still carry `HDR` when only a per-call header differs.

## Android extra / iOS extra

Headers sent **on top of** the baseline for that one path — not the baseline
itself:

| Display | Meaning |
|---------|---------|
| *baseline* | Baseline headers only — no per-call extras |
| `+ lob` | Extra `lob` header on this call |
| `+ countryCode` | Extra `countryCode` header |
| `+ lob (optional)` | Present on some code paths only |
| `+ HeaderMap` | A caller-supplied header map — name the keys in Notes when known |
| `(UID header + body uid)` | Casing or body notes for uid |
| `—` | Path not wired on that platform |

Never prefix these with `§3` or any section sign.

## Section to publish

### 3. API Contract Drift

Publish these sub-sections, in this order, with exactly these columns. Every
table row has as many cells as its header — dropping **Android extra** or
**iOS extra** is a failed audit.

#### Meta

| | |
|---|---|
| **Market** | market and tenant, from code |
| **Android** | branch @ short commit |
| **iOS** | branch @ short commit |
| **BFF prefix** | discovered prefix |
| **Method** | POST JSON, unless the code shows otherwise |
| **Hosts** | `same`, or `drift` and how |
| **Baseline evidence** | Android interceptor file · iOS header file |

#### High-risk findings

| Path | Contract | What to check | Drift |
|------|----------|---------------|-------|

One row per path where the drift can break a request or a journey: a different
orchestration, a body or type the BFF may reject, a payment or auth path wired
on one platform only. If the baseline carries a `CASE` drift that touches this
module's authenticated calls, add it as the last row (e.g.
`uid / UID (baseline)`). Write *None.* instead of the table when nothing is
high risk.

#### Baseline headers

| Header | Android | iOS | Status | Tag |
|--------|---------|-----|--------|-----|

Include **only** baseline headers where **Status** is not `Same` — omit rows
where Android and iOS send the same header with the same effective behavior
(including conditional headers that match on both sides, such as `digitalKey`
when field encryption is on, or identical Dynatrace request tags). **Status**
is exactly one of `Drift`, `A only`, `iOS only` on every published row. **Tag**
is one drift tag in backticks, or `—`. Follow the table with one line naming
the source file of the baseline on each platform. Write *Baseline headers match
on both platforms.* when nothing differs.

#### API inventory

| Path | Contract | Drift | Android extra | iOS extra | Android body | iOS body | Notes |
|------|----------|-------|---------------|-----------|--------------|----------|-------|

- **Path** — BFF relative path in backticks, without the prefix, e.g.
  `` `plan-catalog` ``. Paths that differ only by a `third-party/` variant share
  a row: `` `plan-purchase / third-party/plan-purchase` ``.
- **Contract** — one contract value, in bold.
- **Drift** — drift tags, or `—`.
- **Android body** / **iOS body** — a short field list from what builds the
  payload, with the call site: `msisdn, planId (PlanApi.kt:42)`. `—` where the
  platform does not wire the path.
- **Notes** — what a reader must check, type renames as
  ``Types: `Foo` / `Bar`.``, or `unverified — nearest: <file>`.

Order rows: **Drift** first, then **Android only**, **iOS only**, **Same**.

#### Stale constants

| Path | Android | iOS | Notes |
|------|---------|-----|-------|

Constants this module's code defines or references with no live wiring. Each
platform cell is `integrated`, `stale` or `absent`. Write *None.* when there are
none.

#### Environment base URLs

| Env | Android | iOS | Match |
|-----|---------|-----|-------|

List **only** environments where **Match** is `drift`. Do not repeat rows where
Android and iOS use the same host (trailing slash differences alone are
still `same`). Write *All configured environments match.* when every env is
`same`.

Keep each cell to one line. No line breaks, no bullets or nested tables inside
cells. If the module makes no BFF call on either platform, write one sentence
saying so and publish no tables.

Everything the main spec says about evidence applies here: cite real paths and
lines, never invent an endpoint or a contract, and where static reading cannot
settle a cell, mark it `unverified` instead of guessing. Do not fix either
platform; this section only reports.
