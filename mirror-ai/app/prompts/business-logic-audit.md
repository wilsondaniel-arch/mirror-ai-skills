# Android vs iOS — Business Logic & Behavioral Audit

## Objective
Perform a comprehensive business logic and behavioral comparison of the same feature or module implemented in Android and iOS.

The goal is to identify differences in business rules, functional behavior, state management, API processing, data flow, validations, navigation, error handling, and edge cases.

**Focus exclusively on business logic and functional behavior. Do not compare UI appearance, styling, layouts, or source code line by line in section 1.** A skill may publish its own section about the UI; that is its subject, not this matrix's.

The audit must determine whether both platforms produce equivalent business outcomes when given equivalent inputs, conditions, and user actions, even when their architectures, naming conventions, or implementation approaches differ.

## Phase 1: Discover the Complete Feature

Identify the target feature or module from the user's request. Explore both codebases and discover all relevant dependencies, including:

- Screens, Views, ViewModels, and state holders.
- Models, DTOs, entities, and data mappings.
- Repositories, use cases, services, and API clients.
- Navigation, routing, and inter-screen data transfer.
- Business rules, eligibility checks, validations, and calculations.
- Configuration, feature flags, constants, and environment-specific behavior.
- Shared utilities and components that influence business outcomes.
- Existing unit tests, integration tests, mocks, and fixtures.

Do not restrict discovery to matching filenames or directory structures. Follow function calls, dependency relationships, state updates, API interactions, and navigation paths until the complete business execution flow is understood.

If the user has not specified a feature, ask which feature or module should be audited before proceeding.

### Deliverable
Create a feature inventory showing:

| Component | Android Implementation | iOS Implementation | Business Responsibility |
|---|---|---|---|

Record unresolved dependencies and components that could not be located. Do not assume that a component is missing simply because it has a different name or structure.

## Phase 2: Build the Business Behavior Map

Analyze each platform independently before comparing them.

### A. Business Rules
Identify:
- Conditions, eligibility criteria, and decision-making rules.
- Defaults, priorities, selections, and fallback behavior.
- Validation rules and action restrictions.
- Calculations, thresholds, and business-value transformations.
- Conditions for success, failure, cancellation, or progression.
- Account-, customer-, market-, tenant-, and configuration-specific rules where applicable.

### B. Inputs and Outputs
Trace:
- Initial inputs and navigation arguments.
- User-provided values and relevant application state.
- API requests, parameters, and response fields.
- Locally derived or transformed values.
- Data passed to subsequent components, screens, or requests.
- Final business outcomes and externally observable effects.

### C. State Management and Transitions
Map the applicable initial, loading, success, empty, error, retry, selection, submission, and completion states.

Document:
- What triggers each state transition.
- Which values change or remain unchanged.
- How state is restored or reset.
- How invalid or interrupted transitions are handled.
- Whether stale or asynchronous responses can produce incorrect state.

### D. API and Data Flow
Trace important values through the execution chain:

API response or user input → data/model layer → repository or use case → ViewModel or state holder → business decision → subsequent action or API request → final outcome.

Identify differences in request sequencing, response mapping, null handling, default values, error handling, data transformations, and source-of-truth decisions.

### Deliverable
Produce a separate business behavior map for Android and iOS, showing their rules, inputs, outputs, dependencies, and state transitions.

## Phase 3: Compare Equivalent Scenarios

Compare the actual execution paths on both platforms using equivalent inputs and conditions.

Include applicable scenarios such as:

1. Initial entry and initialization.
2. Successful operations with valid data.
3. Empty results or unavailable options.
4. Missing, null, malformed, or unexpected data.
5. API failures, timeouts, and retries.
6. Valid and invalid user inputs.
7. Default values, selections, and user changes.
8. Back navigation, reopening, and state restoration.
9. Changes to accounts, inputs, or relevant configuration.
10. Repeated actions and duplicate requests.
11. Slow or out-of-order asynchronous responses.
12. Boundary conditions and business calculations.
13. Partial failures and recovery.
14. Successful completion, cancellation, and interruption.
15. Feature flags, configuration variations, and permission-dependent behavior where applicable.

Discover additional scenarios from the implementation and domain requirements. Do not force irrelevant scenarios into the report.

For every applicable scenario, document:
- Preconditions and inputs.
- Android execution path and resulting behavior.
- iOS execution path and resulting behavior.
- Relevant state changes and API interactions.
- Final business outcome on each platform.
- Whether the outcomes are equivalent.
- Any business impact caused by a discrepancy.

## Phase 4: Produce an Evidence-Backed Audit

Investigate each potential difference using source code, tests, API contracts, and available requirements.

Classify every finding as:

- **Confirmed Mismatch:** Evidence demonstrates different behavior under equivalent conditions.
- **Potential Mismatch:** A discrepancy is plausible but its impact requires verification.
- **Requirements Gap:** The intended business rule is unclear or undocumented.
- **Equivalent Behavior:** Different implementations produce equivalent business outcomes.
- **Runtime Verification Required:** Static inspection cannot establish the actual behavior.
- **Missing Implementation:** A required behavior is demonstrably absent, based on sufficient evidence.

For every confirmed or potential mismatch, provide:
1. Finding ID and concise title.
2. Business rule and triggering scenario.
3. Android file path, class/function, and line reference where available.
4. iOS file path, class/function, and line reference where available.
5. Actual behavior on each platform.
6. Expected behavior and supporting evidence, if established.
7. Business impact and severity.
8. Recommended correction or clarification.
9. Regression test required.

Never invent expected behavior, requirements, API contracts, file paths, or line references. When evidence is insufficient, explicitly state what needs confirmation.

## Final Report Structure

Phases 1 to 4 are the work, not the deliverable. Do all of it — the feature
inventory, the behavior maps, the scenario walk-through — because it is what
makes the published section correct. Publish only section 1 below. Do not
include the inventory, the behavior maps, the scenario matrix, or a fix plan as
sections of their own; fold what matters into the matrix. Any skill running
alongside this spec publishes its own numbered sections after this one, and
those are part of the report too.

### 1. Business Logic Difference Matrix

One row per distinct difference, ordered by business impact. Use exactly these
columns, in this order:

| ID | Business Area | Android Behavior | iOS Behavior | Business Impact | Severity | Confidence |
|---|---|---|---|---|---|---|

- **ID** — a short stable tag, e.g. `BL-01`.
- **Business Area** — the rule in four or five words, e.g. "Account eligibility
  filter", not a file or class name.
- **Android Behavior** / **iOS Behavior** — what the platform actually does
  under the same conditions, in one or two sentences, each ending with the
  `path/File.kt:124-129` that shows it. Describe behavior, not syntax. If a
  platform does nothing here, say so.
- **Business Impact** — the user-visible or transactional consequence. If there
  is none, the row does not belong in this matrix.
- **Severity** — `High`, `Medium` or `Low`.
- **Confidence** — exactly one of `Confirmed`, `Potential`, `Missing
  Implementation`, `Requirements Gap` or `Runtime Verification Required`.

Keep every cell to prose on one line — no line breaks, no bullet lists, no
nested tables inside a cell. If there are no differences, write a single
sentence saying so instead of an empty table.

## Strict Constraints
- Analysis only. Do not modify files, refactor code, create commits, or change configuration.
- Do not compare UI appearance, styling, layouts, or pixel-level differences in section 1. Which screens exist and which elements they contain belongs to a skill's section, not to this matrix.
- Do not perform a line-by-line or syntax-level comparison.
- Ignore harmless architectural, naming, and framework differences.
- Trace dependencies across the complete feature before drawing conclusions.
- Compare equivalent business conditions rather than merely comparing similarly named functions.
- Distinguish confirmed defects from assumptions and runtime-only questions.
- Avoid duplicate findings for the same underlying issue.
- Do not claim full coverage when dependencies or source code remain uninspected.
- Finish with the most important discrepancies and the tests needed to verify the fixes.
