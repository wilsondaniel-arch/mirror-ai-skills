import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { screenshotDir } from "./screenshots.ts";
import { repairIosPreviews, saveIosPreviews, savedIosPreviews, writeIosPreviews } from "./ios-preview-writer.ts";
import { readSources } from "./scan.ts";
import type { RenderResult } from "./screenshot-render.ts";

const TIMEOUT_MS = Number(process.env.MIRROR_AI_RENDER_TIMEOUT_MS) || 1_800_000;
/** A big module can carry dozens of previews; past this the build is mostly waiting. */
const MAX_FRAMES = Number(process.env.MIRROR_AI_MAX_IOS_FRAMES) || 12;
const HARNESS_CLASS = "MirrorAIFrames";
/** Past this many unrelated broken tests, the test target is too far gone to patch around. */
const MAX_SET_ASIDE = 10;

export interface IosRenderRequest {
  projectRoot: string;
  iosPath: string;
  moduleKey: string;
  keywords: string[];
}

export interface IosPreview {
  /** Repo-relative path of the file the preview was copied from. */
  file: string;
  /** The `#Preview("…")` title, which becomes the frame's filename. */
  label: string;
  body: string;
}

interface XcodeTarget {
  project: string;
  testDir: string;
  testTarget: string;
  module: string;
}

/**
 * Renders a module's iOS screens on a simulator by borrowing the app's own
 * `#Preview` blocks. Each body is copied into a generated XCTest in the app's
 * unit-test target, which hosts it in a window and writes a PNG. The test file
 * is deleted before returning, so the checkout is left as it was found.
 *
 * A module with no `#Preview` gets bodies written by Claude instead (see
 * `ios-preview-writer.ts`); the ones that render are kept for the next run.
 */
export async function renderIosScreens(request: IosRenderRequest): Promise<RenderResult> {
  const empty = (error: string, log = ""): RenderResult => ({ frames: [], screens: [], gradleModules: [], log, error });
  const target = findXcodeTarget(request.iosPath);
  if (!target) return empty("No Xcode project with a unit-test target that imports the app was found.");
  let previews = findIosPreviews(request.iosPath, request.keywords).slice(0, MAX_FRAMES);
  const writer = { iosPath: request.iosPath, module: target.module, keywords: request.keywords, max: MAX_FRAMES };
  const written = previews.length === 0;
  if (written) {
    previews = savedIosPreviews(request.projectRoot, request.moduleKey, request.iosPath);
    if (previews.length === 0) {
      try {
        previews = await writeIosPreviews(writer);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "it failed";
        return empty(`This module has no iOS #Preview, and writing one failed: ${reason}`);
      }
    }
  }
  if (previews.length === 0) return empty("No iOS view matches this module, so there was nothing to preview.");
  const device = bootSimulator();
  if ("error" in device) return empty(device.error);

  const harness = path.join(target.testDir, `${HARNESS_CLASS}.swift`);
  const outDir = mkdtempSync(path.join(tmpdir(), "mirror-ai-ios-"));
  const screens = [...new Set(previews.map((preview) => path.basename(preview.file)))];
  const setAside = new Map<string, string>();
  let log = "";
  try {
    // A preview may lean on a `private` type from its own file, which the test
    // target cannot see. Written previews get one repair from the compiler's
    // errors; after that, drop the frames the compiler names and try once more.
    for (let attempt = 0; attempt < (written ? 3 : 2); attempt++) {
      const source = harnessSource(target.module, previews);
      writeFileSync(harness, source.text);
      const run = await xcodebuild(request.iosPath, target, device.id, outDir);
      log = run.output;
      const errors = frameErrors(run.output, source.lines);
      // Only the harness runs, yet Xcode compiles the whole test target first,
      // so one stale test elsewhere would block every frame. Blank it for this
      // render (it is restored below) and build again without spending a try.
      const stale = brokenTests(run.output, target.testDir, harness).filter((file) => !setAside.has(file));
      if (stale.length > 0 && setAside.size < MAX_SET_ASIDE) {
        for (const file of stale) {
          setAside.set(file, readFileSync(file, "utf8"));
          writeFileSync(file, "// Set aside by Mirror AI for one render: it did not compile. Restored afterwards.\n");
        }
        attempt--;
        continue;
      }
      if (run.code === 0 || errors.size === 0) break;
      if (written && attempt === 0) {
        const broken = [...errors].map(([index, messages]) => ({ preview: previews[index], errors: messages }));
        const kept = previews.filter((_, index) => !errors.has(index));
        const labels = new Set(kept.map((preview) => preview.label));
        const fixed = await repairIosPreviews(writer, broken).catch(() => []);
        previews = [...kept, ...fixed.filter((preview) => !labels.has(preview.label))];
        if (previews.length === 0) break;
        continue;
      }
      if (errors.size === previews.length) break;
      previews = previews.filter((_, index) => !errors.has(index));
    }
    const frames = collect(request, outDir);
    if (written && frames.length > 0) {
      const rendered = new Set(frames.map((frame) => frame.replace(/\.png$/, "")));
      const kept = previews.filter((preview) => rendered.has(slug(preview.label)));
      saveIosPreviews(request.projectRoot, request.moduleKey, request.iosPath, kept);
    }
    return {
      frames,
      screens,
      gradleModules: [],
      log,
      error: frames.length === 0 ? xcodeError(log) : undefined,
    };
  } finally {
    for (const [file, text] of setAside) writeFileSync(file, text);
    rmSync(harness, { force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Which source file each of a module's iOS frames was rendered from, keyed by frame name. */
export function iosFrameSources(iosPath: string, keywords: string[]): Map<string, string> {
  return previewSources(findIosPreviews(iosPath, keywords));
}

export function previewSources(previews: IosPreview[]): Map<string, string> {
  return new Map(previews.map((preview) => [slug(preview.label), preview.file]));
}

export function findIosPreviews(iosPath: string, keywords: string[]): IosPreview[] {
  const needles = [...new Set(keywords.map(squash).filter((keyword) => keyword.length >= 4))];
  const found: IosPreview[] = [];
  for (const source of readSources(iosPath)) {
    if (!source.relativePath.endsWith(".swift")) continue;
    if (/Tests?\//.test(source.relativePath)) continue;
    if (!source.text.includes("#Preview")) continue;
    // Match the file path or what the preview itself builds, not the whole
    // file: a view that merely links to the module is not one of its screens.
    const inPath = needles.some((needle) => squash(source.relativePath).includes(needle));
    const stem = path.basename(source.relativePath, ".swift");
    parsePreviews(source.text).forEach((preview, index) => {
      if (!inPath && !needles.some((needle) => squash(preview.body).includes(needle))) return;
      found.push({ file: source.relativePath, label: preview.label ?? `${stem} ${index + 1}`, body: preview.body });
    });
  }
  return found;
}

/** Every `#Preview { … }` in a file that is not commented out and needs no preview-only macro. */
export function parsePreviews(text: string): { label: string | null; body: string }[] {
  const previews: { label: string | null; body: string }[] = [];
  const pattern = /^[ \t]*#Preview\b/gm;
  for (const match of text.matchAll(pattern)) {
    let at = (match.index ?? 0) + match[0].length;
    let label: string | null = null;
    at = skipSpace(text, at);
    if (text[at] === "(") {
      const close = matching(text, at, "(", ")");
      if (close < 0) continue;
      label = /^\s*"((?:[^"\\]|\\.)*)"/.exec(text.slice(at + 1, close))?.[1] ?? null;
      at = skipSpace(text, close + 1);
    }
    if (text[at] !== "{") continue;
    const close = matching(text, at, "{", "}");
    if (close < 0) continue;
    const body = text.slice(at + 1, close);
    // `@Previewable` only compiles inside the macro itself.
    if (body.includes("@Previewable")) continue;
    previews.push({ label, body });
  }
  return previews;
}

export function harnessSource(module: string, previews: IosPreview[]): { text: string; lines: [number, number][] } {
  const head = `// Generated by Mirror AI from this app's own #Preview blocks. Deleted after each render.
import XCTest
import SwiftUI
@testable import ${module}

final class ${HARNESS_CLASS}: XCTestCase {
    private let outDir = ProcessInfo.processInfo.environment["MIRROR_AI_OUT"] ?? NSTemporaryDirectory()
`;
  const lines: [number, number][] = [];
  let text = head;
  previews.forEach((preview, index) => {
    const start = text.split("\n").length;
    text += `
    // ${preview.file}
    @MainActor
    func test_frame${index}() throws {
        try snap(AnyView(Self.frame${index}()), name: ${JSON.stringify(slug(preview.label))})
    }

    @MainActor @ViewBuilder
    static func frame${index}() -> some View {
${preview.body}
    }
`;
    lines.push([start, text.split("\n").length]);
  });
  text += `
    @MainActor
    private func snap(_ view: AnyView, name: String) throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.screen.bounds
        window.windowLevel = .alert + 1
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        // Give remote images and onAppear work a moment to settle.
        RunLoop.main.run(until: Date().addingTimeInterval(3))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: outDir).appendingPathComponent("\\(name).png"))
    }
}
`;
  return { text, lines };
}

/** The indexes of frames whose copied body the compiler rejected. */
export function failingFrames(output: string, lines: [number, number][]): Set<number> {
  return new Set(frameErrors(output, lines).keys());
}

/** Test-target files other than the harness that the compiler rejected. */
export function brokenTests(output: string, testDir: string, harness: string): string[] {
  const root = path.resolve(testDir) + path.sep;
  const files = new Set<string>();
  for (const match of output.matchAll(/^(\/[^:\n]+\.swift):\d+:\d+: error: /gm)) {
    const file = path.resolve(match[1]);
    if (file.startsWith(root) && file !== path.resolve(harness)) files.add(file);
  }
  return [...files];
}

/** The compiler's errors for each rejected frame, keyed by its index. */
export function frameErrors(output: string, lines: [number, number][]): Map<number, string[]> {
  const errors = new Map<number, string[]>();
  const pattern = new RegExp(`${HARNESS_CLASS}\\.swift:(\\d+):\\d+: error: (.*)`, "g");
  for (const match of output.matchAll(pattern)) {
    const line = Number(match[1]);
    const index = lines.findIndex(([start, end]) => line >= start && line <= end);
    if (index < 0) continue;
    const messages = errors.get(index) ?? [];
    if (!messages.includes(match[2])) messages.push(match[2]);
    errors.set(index, messages);
  }
  return errors;
}

function findXcodeTarget(iosPath: string): XcodeTarget | null {
  const root = path.resolve(iosPath);
  const entries = safeReaddir(root);
  const project = entries.find((entry) => entry.endsWith(".xcodeproj"));
  if (!project) return null;
  for (const entry of entries) {
    if (!entry.endsWith("Tests") || entry.endsWith("UITests")) continue;
    const testDir = path.join(root, entry);
    if (!isDir(testDir)) continue;
    const module = testableModule(testDir);
    if (module) return { project: path.join(root, project), testDir, testTarget: entry, module };
  }
  return null;
}

/** The module most of the target's tests `@testable import`, which is the app. */
function testableModule(testDir: string): string | null {
  const counts = new Map<string, number>();
  const walk = (dir: string) => {
    for (const entry of safeReaddir(dir)) {
      const full = path.join(dir, entry);
      if (isDir(full)) walk(full);
      else if (entry.endsWith(".swift")) {
        for (const match of readFileSync(full, "utf8").matchAll(/@testable\s+import\s+(\w+)/g)) {
          counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
        }
      }
    }
  };
  walk(testDir);
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function bootSimulator(): { id: string } | { error: string } {
  const list = spawnSync("xcrun", ["simctl", "list", "devices", "available", "-j"], { encoding: "utf8" });
  if (list.status !== 0) return { error: "Xcode's simulator tools are not available (xcrun simctl failed)." };
  const runtimes = (JSON.parse(list.stdout) as { devices: Record<string, { udid: string; name: string; state: string }[]> }).devices;
  const phones = Object.values(runtimes).flat().filter((device) => device.name.startsWith("iPhone"));
  const wanted = process.env.MIRROR_AI_IOS_SIMULATOR;
  const device =
    (wanted && phones.find((phone) => phone.name === wanted || phone.udid === wanted)) ||
    phones.find((phone) => phone.state === "Booted") ||
    phones.find((phone) => /Pro$/.test(phone.name)) ||
    phones[0];
  if (!device) return { error: "No iPhone simulator is installed." };
  if (device.state !== "Booted") spawnSync("xcrun", ["simctl", "boot", device.udid]);
  return { id: device.udid };
}

function xcodebuild(
  cwd: string,
  target: XcodeTarget,
  deviceId: string,
  outDir: string,
): Promise<{ code: number; output: string }> {
  const scheme = process.env.MIRROR_AI_IOS_SCHEME || target.module;
  const configuration = process.env.MIRROR_AI_IOS_CONFIGURATION || (hasConfiguration(target.project, "Dev") ? "Dev" : "");
  const args = [
    "-project", target.project,
    "-scheme", scheme,
    ...(configuration ? ["-configuration", configuration] : []),
    "-destination", `id=${deviceId}`,
    // Package macros and plugins otherwise wait on an approval dialog that a
    // headless build can never answer.
    "-skipMacroValidation",
    "-skipPackagePluginValidation",
    `-only-testing:${target.testTarget}/${HARNESS_CLASS}`,
    "test",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("xcodebuild", args, {
      cwd,
      env: { ...process.env, TEST_RUNNER_MIRROR_AI_OUT: outDir },
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The iOS render ran past ${Math.round(TIMEOUT_MS / 60000)} minutes and was stopped.`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function hasConfiguration(project: string, name: string): boolean {
  try {
    return readFileSync(path.join(project, "project.pbxproj"), "utf8").includes(`name = ${name};`);
  } catch {
    return false;
  }
}

function collect(request: IosRenderRequest, outDir: string): string[] {
  const pngs = safeReaddir(outDir).filter((file) => file.endsWith(".png"));
  if (pngs.length === 0) return [];
  const out = screenshotDir(request.projectRoot, request.moduleKey, "ios");
  mkdirSync(out, { recursive: true });
  for (const png of pngs) writeFileSync(path.join(out, png), readFileSync(path.join(outDir, png)));
  return pngs.sort();
}

function xcodeError(output: string): string {
  const error = output.split("\n").find((line) => /: error: /.test(line));
  if (error) return error.replace(/^.*?([^/]+\.swift:\d+:\d+: error: )/, "$1").slice(0, 300);
  if (/TEST SUCCEEDED/.test(output)) return "The tests ran but wrote no frames.";
  return "The Xcode build failed; see the log.";
}

function matching(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (char === '"') {
      // Skip a string literal so a brace inside one is not counted.
      at++;
      while (at < text.length && text[at] !== '"' && text[at] !== "\n") at += text[at] === "\\" ? 2 : 1;
      continue;
    }
    if (char === "/" && text[at + 1] === "/") {
      at = text.indexOf("\n", at);
      if (at < 0) return -1;
      continue;
    }
    if (char === opener) depth++;
    else if (char === closer && --depth === 0) return at;
  }
  return -1;
}

function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at])) at++;
  return at;
}

function isDir(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** `AUTO_PAY`, `AutoPay` and `auto-pay` all read as `autopay`. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "frame";
}

