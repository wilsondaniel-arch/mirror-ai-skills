import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RenderQueue, type RenderTarget } from "../src/render-jobs.ts";
import { brokenTests, failingFrames, findIosPreviews, frameErrors, harnessSource, parsePreviews } from "../src/screenshot-render-ios.ts";
import { findIosViews, parseWrittenPreviews, saveIosPreviews, savedIosPreviews } from "../src/ios-preview-writer.ts";
import { findScreens } from "../src/screenshot-render.ts";
import { clearSourceCache } from "../src/scan.ts";
import { screenshotDir } from "../src/screenshots.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("previews are read with their titles, and commented or preview-only ones are skipped", () => {
  const previews = parsePreviews(`
#Preview("Card — expired") {
    CardView(title: "a } brace in a string")
        .padding()
}

//#Preview {
//    Hidden()
//}

#Preview {
    @Previewable @State var on = true
    Toggle("x", isOn: $on)
}

#Preview(traits: .sizeThatFitsLayout) {
    Plain()
}
`);
  assert.equal(previews.length, 2);
  assert.equal(previews[0].label, "Card — expired");
  assert.match(previews[0].body, /a \} brace in a string/);
  assert.match(previews[0].body, /\.padding\(\)/);
  assert.equal(previews[1].label, null);
  assert.match(previews[1].body, /Plain\(\)/);
});

test("iOS previews match the module by path or by what the preview builds", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirror-ios-"));
  try {
    mkdirSync(path.join(root, "App/Modules/AutoPay"), { recursive: true });
    mkdirSync(path.join(root, "App/Modules/Settings"), { recursive: true });
    mkdirSync(path.join(root, "App/Modules/Home"), { recursive: true });
    writeFileSync(path.join(root, "App/Modules/AutoPay/CardView.swift"), '#Preview("Card") {\n    CardView()\n}\n');
    writeFileSync(
      path.join(root, "App/Modules/Settings/ToggleView.swift"),
      '#Preview("Biometric") {\n    BiometricView()\n}\n#Preview("Auto Logout") {\n    HandleAutoLogoutView()\n}\n',
    );
    writeFileSync(path.join(root, "App/Modules/Home/Tile.swift"), "// opens autopay\n#Preview {\n    Tile()\n}\n");
    clearSourceCache();
    assert.deepEqual(
      findIosPreviews(root, ["AUTO_PAY", "AutoPay"]).map((preview) => preview.label),
      ["Card"],
    );
    assert.deepEqual(
      findIosPreviews(root, ["AUTO_LOGOUT"]).map((preview) => preview.label),
      ["Auto Logout"],
    );
  } finally {
    clearSourceCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compile error is traced back to the preview it came from", () => {
  const harness = harnessSource("App", [
    { file: "A.swift", label: "One", body: "    One()" },
    { file: "B.swift", label: "Two", body: "    Two()" },
  ]);
  const twoLine = harness.text.split("\n").findIndex((line) => line.includes("Two()")) + 1;
  const output = `/x/MirrorAIFrames.swift:${twoLine}:5: error: cannot find 'Two' in scope\n/x/Other.swift:3:1: error: unrelated`;
  assert.deepEqual([...failingFrames(output, harness.lines)], [1]);
  assert.match(harness.text, /@testable import App/);
  assert.match(harness.text, /name: "two"/);
});

test("each rejected frame keeps its own compiler errors", () => {
  const harness = harnessSource("App", [
    { file: "A.swift", label: "One", body: "    One()" },
    { file: "B.swift", label: "Two", body: "    Two()" },
  ]);
  const twoLine = harness.text.split("\n").findIndex((line) => line.includes("Two()")) + 1;
  const output = [
    `/x/MirrorAIFrames.swift:${twoLine}:5: error: cannot find 'Two' in scope`,
    `/x/MirrorAIFrames.swift:${twoLine}:5: error: cannot find 'Two' in scope`,
  ].join("\n");
  assert.deepEqual([...frameErrors(output, harness.lines)], [[1, ["cannot find 'Two' in scope"]]]);
});

test("only stale tests in the test target are set aside, never the harness or app code", () => {
  const output = [
    "/r/App Tests/Chat/LoggerTests.swift:121:17: error: cannot find 'NSErrorFailingURLKey' in scope",
    "/r/App Tests/Chat/LoggerTests.swift:130:2: error: again",
    "/r/App Tests/MirrorAIFrames.swift:12:5: error: cannot find 'Two' in scope",
    "/r/App/Home/HomeView.swift:3:1: error: app code",
    "/r/App Tests/Chat/LoggerTests.swift:140:2: warning: not an error",
  ].join("\n");
  assert.deepEqual(brokenTests(output, "/r/App Tests", "/r/App Tests/MirrorAIFrames.swift"), ["/r/App Tests/Chat/LoggerTests.swift"]);
});

test("written previews are read from the model's JSON, skipping malformed and duplicate entries", () => {
  const text = `Here they are:
\`\`\`json
[
  {"file": "App/BillHistory/ListView.swift", "label": "Bill list", "body": "ListView(items: [.sample])\\n    .environmentObject(Nav())"},
  {"file": "App/BillHistory/ListView.swift", "label": "Bill list", "body": "ListView(items: [])"},
  {"file": "App/BillHistory/Detail.swift", "label": "Detail", "body": "@Previewable @State var x = 1\\nDetail()"},
  {"file": "App/BillHistory/Empty.swift", "label": "Empty", "body": "   "},
  {"label": "No file", "body": "Thing()"}
]
\`\`\``;
  const previews = parseWrittenPreviews(text);
  assert.deepEqual(previews.map((preview) => preview.label), ["Bill list"]);
  assert.match(previews[0].body, /environmentObject/);
  assert.deepEqual(parseWrittenPreviews("I could not find any views."), []);
});

test("only module views a test target can see are offered to the preview writer, screens first", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirror-ios-"));
  try {
    mkdirSync(path.join(root, "App/Modules/BillHistory/Views"), { recursive: true });
    mkdirSync(path.join(root, "App/Modules/Home"), { recursive: true });
    mkdirSync(path.join(root, "AppTests/BillHistory"), { recursive: true });
    writeFileSync(
      path.join(root, "App/Modules/BillHistory/Views/BillHistoryRow.swift"),
      "struct BillHistoryRow: View {\n  var body: some View { Text(\"\") }\n}\n",
    );
    writeFileSync(
      path.join(root, "App/Modules/BillHistory/Views/BillHistoryListView.swift"),
      "struct BillHistoryListView: View {}\nprivate struct MonthRow: View {}\nfileprivate struct Gap: View {}\nstruct Banner<Content: View>: View {}\n",
    );
    writeFileSync(path.join(root, "App/Modules/BillHistory/BillHistoryStrings.swift"), "enum BillHistoryStrings {}\n");
    writeFileSync(path.join(root, "App/Modules/Home/HomeView.swift"), "struct HomeView: View {} // billhistory link\n");
    writeFileSync(path.join(root, "AppTests/BillHistory/BillHistoryTests.swift"), "struct FakeView: View {}\n");
    clearSourceCache();
    assert.deepEqual(findIosViews(root, ["BILL_HISTORY"]), [
      { file: "App/Modules/BillHistory/Views/BillHistoryListView.swift", views: ["BillHistoryListView", "Banner"] },
      { file: "App/Modules/BillHistory/Views/BillHistoryRow.swift", views: ["BillHistoryRow"] },
    ]);
  } finally {
    clearSourceCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved written previews are reused only for the checkout they rendered against", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirror-ios-"));
  try {
    const previews = [{ file: "A.swift", label: "One", body: "\nOne()\n" }];
    saveIosPreviews(root, "billhistory", "/repos/ios", previews);
    assert.deepEqual(savedIosPreviews(root, "billhistory", "/repos/ios"), previews);
    assert.deepEqual(savedIosPreviews(root, "billhistory", "/repos/other-ios"), []);
    assert.deepEqual(savedIosPreviews(root, "autopay", "/repos/ios"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function target(root: string, moduleKey: string): RenderTarget {
  return { projectRoot: root, androidPath: "/a", iosPath: "/i", moduleKey, keywords: [moduleKey] };
}

test("renders run once per platform and a platform with frames is left alone", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirror-queue-"));
  try {
    mkdirSync(screenshotDir(root, "autopay", "android"), { recursive: true });
    writeFileSync(path.join(screenshotDir(root, "autopay", "android"), "hub.png"), PNG);
    const calls: string[] = [];
    const queue = new RenderQueue({
      android: async (job) => {
        calls.push(`android:${job.moduleKey}`);
        return { frames: ["a.png"], screens: [], gradleModules: [], log: "" };
      },
      ios: async (job) => {
        calls.push(`ios:${job.moduleKey}`);
        return { frames: [], screens: [], gradleModules: [], log: "", error: "No iOS view with a #Preview matches this module." };
      },
    });

    const job = queue.enqueue(target(root, "autopay"));
    assert.equal(job.android.state, "skipped");
    assert.equal(job.ios.state, "queued");
    // A second request while it is running joins the same job.
    assert.equal(queue.enqueue(target(root, "autopay")), job);
    await queue.idle();

    assert.deepEqual(calls, ["ios:autopay"]);
    assert.equal(queue.status("autopay")?.ios.state, "failed");
    assert.match(queue.status("autopay")?.ios.error ?? "", /No iOS view/);

    queue.enqueue(target(root, "autopay"), true);
    await queue.idle();
    assert.deepEqual(calls, ["ios:autopay", "android:autopay", "ios:autopay"]);
    assert.equal(queue.status("autopay")?.android.state, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a renderer that throws is reported, and the queue keeps going", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirror-queue-"));
  try {
    const queue = new RenderQueue({
      android: async () => {
        throw new Error("Gradle exploded");
      },
      ios: async () => ({ frames: ["x.png"], screens: [], gradleModules: [], log: "" }),
    });
    queue.enqueue(target(root, "flowoffers"));
    await queue.idle();
    assert.equal(queue.status("flowoffers")?.android.error, "Gradle exploded");
    assert.equal(queue.status("flowoffers")?.ios.state, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("android screens are the files named for the module, and a parenthesised preview name still parses", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirror-android-"));
  try {
    const main = (module: string) => path.join(root, module, "src/main/java/com/app");
    mkdirSync(main("feature/autopay"), { recursive: true });
    mkdirSync(main("feature/home"), { recursive: true });
    writeFileSync(
      path.join(main("feature/autopay"), "ActivateAutopaySheet.kt"),
      'package com.app\n\n@Preview(showBackground = true, name = "Sheet (Figma 8053:58487)")\n@Composable\nprivate fun SheetPreview() {}\n',
    );
    writeFileSync(
      path.join(main("feature/home"), "HomeScreen.kt"),
      'package com.app\n// opens Autopay\n@Preview(name = "Home")\n@Composable\nprivate fun HomePreview() {}\n',
    );
    clearSourceCache();
    const screens = findScreens(root, ["AUTO_PAY", "Autopay"]);
    assert.deepEqual(screens.map((screen) => path.basename(screen.file)), ["ActivateAutopaySheet.kt"]);
    assert.deepEqual(screens[0].previews, [{ name: "SheetPreview", label: "Sheet (Figma 8053:58487)" }]);
  } finally {
    clearSourceCache();
    rmSync(root, { recursive: true, force: true });
  }
});
