import assert from "node:assert/strict";
import { test } from "node:test";
import { findHardcodedCopy, hardcodedCopySection } from "../src/hardcoded-copy.ts";

const src = (relativePath: string, text: string) => ({ relativePath, text, lower: text.toLowerCase() });

test("finds Swift button and title literals with exact lines, skipping keys, logs and previews", () => {
  const text = [
    'Button("Pay now") { pay() }', // 1
    'Text(NSLocalizedString("PAY_TITLE", comment: ""))', // 2 localized: skip
    'print("Debug only")', // 3 log: skip
    '.navigationTitle("Payments")', // 4
    'Text("PAY_NOW_CTA")', // 5 key-shaped: skip
    '#Preview {', // 6
    '  Button("Sample") {}', // 7 preview: skip
    '}',
    'struct Other: View {', // 9 preview ends
    '  var body: some View { Text("Done") }', // 10
    '}',
  ].join("\n");
  const hits = findHardcodedCopy("iOS", [src("App/PayView.swift", text)]);
  assert.deepEqual(
    hits.map((hit) => [hit.text, hit.line, hit.type]),
    [["Pay now", 1, "button"], ["Payments", 4, "title"], ["Done", 10, "text"]],
  );
});

test("finds Kotlin literals but not stringResource or @Preview sample data", () => {
  const text = [
    "@Composable fun PayScreen() {", // 1
    '  Text(text = "Pay now")', // 2
    "  Text(stringResource(R.string.pay))", // 3 skip
    '  Log.d("Pay", "clicked")', // 4 skip
    "}",
    "@Preview", // 6
    "@Composable fun PayScreenPreview() {", // 7
    '  Text("Sample plan")', // 8 skip
    "}",
  ].join("\n");
  const hits = findHardcodedCopy("Android", [src("feature/PayScreen.kt", text)]);
  assert.deepEqual(hits.map((hit) => [hit.text, hit.line]), [["Pay now", 2]]);
});

test("the section joins the same literal on both platforms into one Both row", () => {
  const android = findHardcodedCopy("Android", [src("a/Pay.kt", 'fun x() { Text("Pay now") }')]);
  const ios = findHardcodedCopy("iOS", [src("i/Pay.swift", 'Button("Pay Now") {}\nText("Only iOS")')]);
  const section = hardcodedCopySection(android, ios);
  assert.match(section, /^### Hard-coded copy on buttons and labels/);
  assert.match(section, /\| "Pay now" \| "Pay Now" \| Both \| `a\/Pay\.kt:1`; `i\/Pay\.swift:1` \|/);
  assert.match(section, /\| — \| "Only iOS" \| iOS \|/);
  assert.match(section, /Android only 0, iOS only 1, both 1/);
});

test("the section says so when nothing is hard-coded", () => {
  assert.match(hardcodedCopySection([], []), /No hard-coded user-visible copy was found/);
});
