# ui-skill — UI Difference

Runs as part of the audit, on the same module and the same evidence. It adds one
section to the report, after the Business Logic Difference Matrix.

## Objective

Say how much of this module's UI differs between Android and iOS, as a number
the reader can check, by counting addressable UI slots on every screen.

**Read this before you start, and put it in your own words in the section's
first sentence:** the unit of measurement is partly a measure of how diligently
each team instrumented its screens, not purely of the UI. Two teams can build
the same screen and tag a different number of slots. The counts below are a
comparison instrument, not a metric to track over time.

Styling is out of scope here. Colours, fonts, spacing, padding, animation,
corner radii and shadows are not differences for this section. This section
counts which addressable slots exist and whether they agree, not how they look.
A behaviour difference belongs in section 2, and appears here only when it
changes which slot the user sees.

## **Do not compute, estimate or state any percentage anywhere in this section.**

You publish integers. The reader's page computes every percentage from them. A
percentage written into the table becomes a second number free to disagree with
the one on screen. Counts only: no `~`, no ranges, no "about", no "roughly".

## What a screen is

A nav destination, sheet, modal or dialog — anything that takes over the view.
Shared design-system components are counted where they are used, never as rows
of their own.

### Enumerating screens: use the navigation registry, never a filename grep

**Android.** The authority is the dependency-injection registrations,
`entry<XxxRoute> { XxxDestination(...) }`, for example in
`feature/feature-postpaid-line/src/main/java/com/feature/postpaidline/di/PostpaidLineModule.kt`.
Cross-check the route types against
`designsystem/src/main/java/com/designsystem/navigation/NavKey.kt`.

Grep for `entry<`, **not** `entry<...Route>` — around eight nav keys do not
carry the `Route` suffix, and the stricter pattern silently loses them. This app
uses Navigation 3: there is no `NavHost` and no `composable("route")`. A
`@Composable` that no `entry<>` reaches is a component, not a screen.

**iOS.** The authority is the `case .` arms of the `switch` in
`LLA-SuperApp-iOS/App/RootView.swift`. Do **not** enumerate
`RootNavigationDestination` in `NavigationManager.swift`: `RootView` ends in
`default: ComingSoonView()`, so the enum lists cases that render nothing and
over-counts.

Never enumerate by counting `struct X: View` either — most are components.

### Two traps that will corrupt the count

**Duplicate implementations.** Android can hold a live package and an orphan
copy that define the same screen. `.../postpaidline/flowoffers/` is live;
`.../postpaidline/flows/flowoffers/` is an orphan nothing registers, and both
define `FlowOffersScreen`, `FlowOffersDestination` and `FlowOffersViewModel` —
and both carry the same Figma id, so the Figma key does not tell them apart.
Only the DI registration does. Resolve the `XxxDestination` symbol the `entry<>`
lambda actually constructs, follow it to its file, and count only that tree.
Name the rejected copy in the excluded-screens note so the reader knows you saw
it.

**The iOS accessibility grep.** iOS instruments with
`.optionalAccessibilityIdentifier(...)`, not `.accessibilityIdentifier(...)`.
Grepping only the latter returns zero for views that are in fact densely
instrumented. Grep both spellings.

## What counts as one element

One **addressable UI slot**. Four classes, in precedence order. A slot is
counted once, under the first class that claims it.

1. **Accessibility slot** — one `addAccessibilityId(...)`, `testTag(...)` or
   `contentDescription =` call site on Android; one
   `.optionalAccessibilityIdentifier(...)` or `.accessibilityIdentifier(...)`
   call site on iOS. This is the primary unit.
2. **Remote string key** — a `PostpaidStrings.X` → `tenantKey(...)` reference on
   Android, a `DynamicLabels.X` reference on iOS, **only when no accessibility
   slot on this screen already covers it**. Without that rule the screen title
   is counted twice. These are **copy keys on a screen already in scope** —
   never enumerate modules from `StringKeys.kt` or the `DynamicLabels` enum in
   `Enum.swift`. The module list is the redirection catalog only (`CTAModuleType`
   / `NavigationTarget` on Android, `RedirectionTarget` on iOS).
3. **Declared state branch** — a state the screen's own code branches to:
   loading or shimmer, empty, error, success, and each enumerated step of a
   multi-step screen. One per branch.
4. **Uninstrumented interactive control** — a `Button`, `TextField`,
   `Checkbox`, `Switch` or `clickable` on Android, a `Button {}`, `TextField`
   or `.onTapGesture` on iOS, carrying no accessibility id and no remote string.
   The catch-all, so a control one platform lacks is never invisible.

**Not elements.** Colours, fonts, spacing, padding, modifiers, animation, radii,
shadows, `@Preview` and `#Preview` bodies, anything in a test file, and a
private helper counted a second time at its call site.

**Lists.** A repeated row template counts as **one** element on each side,
whatever the item count. The slot-index convention is for joining, not counting
— otherwise three mock items against five fabricate a difference.

## Matched, and when a matched slot is divergent

**Matched (M)** is the number of slots you joined to a counterpart on the other
platform. Join on the strongest key available, and say which you used:

1. **Figma node id** in a doc comment. Both codebases cite the same node ids —
   `15248:81544`, `18678:99772`, `25355:73237` and others. This is the single
   strongest signal that two screens, or two slots, are the same thing. Note the
   duplicate-implementation trap above: a Figma id alone cannot tell a live
   screen from an orphan copy.
2. **Remote string key, byte-identical.** Android
   `tenantKey("_FLOW_OFFERS_LISTING_TITLE", …)` in a `*Strings.kt`; iOS
   `case FLOW_OFFERS_LISTING_TITLE` in `DynamicLabels.swift`. Strip the tenant
   prefix and the leading underscore, then compare exactly. Reliable where it
   applies, but the overlap is thinner than you would expect — treat it as a
   secondary key, not the backbone.
3. **Accessibility ids.** Both platforms compose these at runtime, so neither
   has a literal id in the view file; resolve them before comparing. Four
   divergences are conventional and deterministic, and must be normalised away:
   snake_case against camelCase; Android puts the type first (`lbl_`, `btn_`,
   `icon_`) where iOS puts it last (`_text`, `_button`, `_icon`, `_container`);
   the screen namespace differs (`postpaid_line_flow_offers` against
   `flowOffers_FlowOffersView`); list indices are 1-based on Android and 0-based
   on iOS. Where a composed iOS id is hard to resolve, the identifier contract
   tests under `LLA-SuperApp-iOSTests` pin the exact final strings.
4. **Control shape and position** — the last resort. Say so in the Join Key
   cell, so the reader discounts that row.

A slot you cannot join by any of these is Android-only or iOS-only.

**Divergent (D)** is how many of the matched slots disagree. Each needs evidence
and a citation:

- a different control type for the same slot — a button against a link, a
  dropdown against a bottom sheet
- a different remote string key, so different copy
- one platform's slot is conditional where the other's is unconditional
- a different state set for the same slot — one platform has an error state
  here and the other does not
- an order that changes what the user sees first

**The rule that matters most:** an accessibility id that differs only by one of
the four conventions above is **not** divergent. It is the same slot, named to
each platform's house style. Ignore this and the count stops measuring the UI
and starts measuring naming conventions.

## Pairing

**Paired** — one Android screen against one iOS screen.

**Many-to-one** — the two navigation graphs are not one-to-one. Android may
split across several routes what iOS folds into one view with an internal step
machine. Publish one row for the whole group: Android Elements is the total
across every Android route in the group, iOS Elements the total across every iOS
route. Count the extra nav chrome the split creates — an extra toolbar, title
and back affordance per extra route — on the side that has it; it matches
nothing, which is correct, because the user really does see more screens. Name
every route in the Screen cell so a reader can disagree with your grouping.

**Android only / iOS only** — a screen the navigation registry reaches on one
platform with no counterpart on the other. Give it a row with the elements it
has and `0` on the other side, `0` matched and `0` divergent. These are reported
separately and are **excluded from the percentage**; the reader needs to see
them, but a missing screen is a different fact from two screens disagreeing.

**The invariant to hold, and to publish:** every route in each platform's
navigation registry appears in exactly one row, exactly once. The coverage table
is where a reader checks that it held.

## Section to publish

### 2. UI Difference

Open with one sentence on what the counts measure and what they do not, per the
Objective above.

Then one table, exactly these columns:

| Platform | Screens in nav registry | Screens rowed | Screens with no counterpart | Elements counted |
|---|---|---|---|---|

One row for Android, one for iOS. `Elements counted` must equal the sum of that
platform's element column in the table below — if it does not, you have
double-counted or dropped a screen, and should fix it before publishing.

Then one row per screen or pair group, paired rows first, ordered by how much
they differ, with exactly these columns:

| ID | Screen | Pairing | Android Elements | iOS Elements | Matched | Divergent | Join Key | Largest Difference |
|---|---|---|---|---|---|---|---|---|

- **ID** — `UI-01`, `UI-02`, in order.
- **Screen** — the two counterparts, `FlowOffersRoute ↔ FlowOffersView`. For a
  group, name every route, joined with `+`.
- **Pairing** — exactly one of `Paired`, `Many-to-one`, `Android only`,
  `iOS only`.
- **Android Elements**, **iOS Elements**, **Matched**, **Divergent** — a bare
  non-negative whole number and nothing else. No `~`, no range, no word, no
  footnote marker. `Matched` can never exceed the smaller of the two element
  counts, and `Divergent` can never exceed `Matched`.
- **Join Key** — how you joined this screen's slots, strongest first:
  `Figma 15248:80432`, `string keys`, `a11y ids`, `control shape`. Short.
- **Largest Difference** — one sentence naming the single biggest divergence,
  ending in a `path/File.kt:124-129` citation. For an unpaired screen, say what
  the other platform has instead.

Keep every cell to one line of prose. No line breaks, no bullets, no nested
tables. If the module has no screen on either platform, write one sentence
saying so and publish no tables.

### The layout view, for the three most different paired screens

After the scored table, publish a layout block for the **three paired screens
with the most divergence** — fewer if the module has fewer. These let a reviewer
see the difference rather than read a number, so spend the words here and keep
the rest terse.

Introduce each with a line naming the screen, then one table, exactly these
columns:

| Slot | Type | Android | iOS | State |
|---|---|---|---|---|

- **Slot** — what the slot is for, in two or three words: `Screen title`,
  `Account selector`, `Offer row — Explore`. Not an identifier.
- **Type** — one of `appbar`, `title`, `text`, `button`, `link`, `input`,
  `toggle`, `image`, `icon`, `list`, `row`, `sheet`, `dialog`, `state`,
  `spacer`. Pick the closest; this is what the reader's page draws.
- **Android** / **iOS** — what that platform actually renders in that slot, in
  a few words: the copy, the control, or the condition. Write `—` where the
  platform has nothing there.
- **State** — exactly one of `same`, `divergent`, `android-only`, `iOS-only`.

**Rows go in render order, top of the screen first**, so the two columns read
like the screens themselves. A slot either platform lacks still gets a row, so
the gap is visible in place rather than inferred.

**The layout must agree with that screen's counts.** The number of rows marked
`divergent`, `android-only` and `iOS-only` is that screen's
`(A − M) + (I − M) + D`. If they disagree, one of the two is wrong — fix it
before publishing. A reader will check.

Keep each cell to a few words. This is a reconstruction of the screen from its
source, not a screenshot, and it should read like one: the slots in order, what
each platform puts there, and where they part company.

### Hard-coded copy on buttons and labels

After the layout views, publish every user-visible string in this module's
screens that is **hard-coded on either platform** — written as a literal in
code instead of coming from a remote string key, a localized resource
(`strings.xml`, `Localizable.strings`, `NSLocalizedString`), or a constants file
of string keys. Buttons and links first, then titles, labels, placeholders,
dialog text and empty states. Cover every screen you read, not only the three
layout views. A constants file that holds raw display text (for example
`Constants+Strings.swift` returning `"Continue"`) counts as hard-coded; name the
file in the citation.

Introduce it with one sentence, then one table, exactly these columns:

| ID | Screen | Element | Type | Android Text Source | iOS Text Source | Hard-coded On | Citation |
|---|---|---|---|---|---|---|---|

- **ID** — `HC-01`, `HC-02`, in order.
- **Screen** — the screen's route or view name on the platform that has it.
- **Element** — what the string is for, in two or three words: `Pay button`,
  `Retry link`, `Dialog title`.
- **Type** — one of `button`, `link`, `title`, `text`, `input`, `dialog`,
  `state`.
- **Android Text Source** / **iOS Text Source** — the literal in quotes, e.g.
  `"Pay now"`, or the key it reads, e.g. `PAY_NOW_CTA (remote)`, or `—` when
  the platform has no such element.
- **Hard-coded On** — exactly one of `Android`, `iOS`, `Both`.
- **Citation** — `path/File.kt:124` for each hard-coded literal; both
  platforms' citations when both are hard-coded, separated by `; `.

Report a literal only when you can see it in the source shown to you. If none
is visible, write one sentence saying no hard-coded copy was found in the code
read, and publish no table.

Close with a short note listing any screen you found but excluded, and why — an
orphan package, a route that renders nothing. One line each.

Everything the main spec says about evidence applies here: cite real paths and
lines, never invent a screen or an identifier, and where static reading cannot
settle whether two slots are the same, join them by the weakest honest key and
say so in the Join Key cell rather than guessing.
