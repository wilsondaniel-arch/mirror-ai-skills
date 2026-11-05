/**
 * Finds user-visible copy written as string literals in UI code — button
 * labels, titles, text, placeholders, dialog text — without a model. Whether a
 * string is a literal is a fact the source states, so reading it with patterns
 * costs no tokens, cites exact lines, and can cover every file of a module,
 * including files the model never reads.
 */
import path from "node:path";
import type { RepoSource } from "./scan.ts";

export type CopyType = "button" | "link" | "title" | "text" | "input" | "dialog";

export interface CopyHit {
  platform: "Android" | "iOS";
  file: string;
  line: number;
  text: string;
  type: CopyType;
  element: string;
}

interface Pattern {
  /** Captures the literal in group 1. */
  regex: RegExp;
  type: CopyType;
  element: string;
}

const STR = String.raw`"((?:[^"\\]|\\.){1,200})"`;

const SWIFT: Pattern[] = [
  { regex: new RegExp(String.raw`\bButton\(\s*${STR}`, "g"), type: "button", element: "Button label" },
  { regex: new RegExp(String.raw`\.setTitle\(\s*${STR}`, "g"), type: "button", element: "Button title" },
  { regex: new RegExp(String.raw`\bUIAlertAction\(\s*title:\s*${STR}`, "g"), type: "button", element: "Alert action" },
  { regex: new RegExp(String.raw`\bUIAlertController\(\s*title:\s*${STR}`, "g"), type: "dialog", element: "Alert title" },
  { regex: new RegExp(String.raw`\bmessage:\s*${STR}`, "g"), type: "dialog", element: "Dialog message" },
  { regex: new RegExp(String.raw`\.navigationTitle\(\s*${STR}`, "g"), type: "title", element: "Screen title" },
  { regex: new RegExp(String.raw`\bnavigationItem\.title\s*=\s*${STR}`, "g"), type: "title", element: "Screen title" },
  { regex: new RegExp(String.raw`\bLink\(\s*${STR}`, "g"), type: "link", element: "Link" },
  { regex: new RegExp(String.raw`\bLabel\(\s*${STR}`, "g"), type: "text", element: "Label" },
  { regex: new RegExp(String.raw`\bText\(\s*${STR}`, "g"), type: "text", element: "Text" },
  { regex: new RegExp(String.raw`\bTextField\(\s*${STR}`, "g"), type: "input", element: "Field placeholder" },
  { regex: new RegExp(String.raw`\bplaceholder\s*[:=]\s*${STR}`, "g"), type: "input", element: "Placeholder" },
  { regex: new RegExp(String.raw`\.text\s*=\s*${STR}`, "g"), type: "text", element: "Label text" },
  { regex: new RegExp(String.raw`\btitle\s*[:=]\s*${STR}`, "g"), type: "title", element: "Title" },
];

const KOTLIN: Pattern[] = [
  { regex: new RegExp(String.raw`\bText\(\s*(?:text\s*=\s*)?${STR}`, "g"), type: "text", element: "Text" },
  { regex: new RegExp(String.raw`\b(?:confirmButton|dismissButton)\b[^"\n]*${STR}`, "g"), type: "button", element: "Dialog button" },
  { regex: new RegExp(String.raw`\b(?:buttonText|ctaText|primaryText|secondaryText|actionText|label)\s*=\s*${STR}`, "g"), type: "button", element: "Button label" },
  { regex: new RegExp(String.raw`\b(?:title|titleText|headerTitle|toolbarTitle)\s*=\s*${STR}`, "g"), type: "title", element: "Title" },
  { regex: new RegExp(String.raw`\b(?:placeholder|hint|placeholderText)\s*=\s*${STR}`, "g"), type: "input", element: "Placeholder" },
  { regex: new RegExp(String.raw`\b(?:message|description|subtitle|body)\s*=\s*${STR}`, "g"), type: "text", element: "Body text" },
  { regex: new RegExp(String.raw`\.(?:setText|setTitle|setMessage|setPositiveButton|setNegativeButton)\(\s*${STR}`, "g"), type: "dialog", element: "View/dialog text" },
  { regex: new RegExp(String.raw`\bToast\.makeText\([^,]+,\s*${STR}`, "g"), type: "dialog", element: "Toast" },
];

/** Lines that carry strings nobody sees: logging, analytics, keys, routes, tests. */
const SKIP_LINE =
  /\b(Log\.[dewiv]|Timber\.|print\(|debugPrint|NSLog|os_log|logger\.|analytics|Analytics|track(Event)?\(|firebase|logEvent|Crashlytics|NSLocalizedString|String\(localized|LocalizedStringKey|stringResource|getString\(|R\.string|@SerializedName|@Json|@SerialName|CodingKeys|case\s+\w+\s*=|UserDefaults|forKey:|identifier|accessibilityIdentifier|testTag|route\s*=|navigate\(|Notification\.Name|URL\(string|\.png|\.jpg|systemName:|Image\()/;

/** Literal text a person would read: has a letter, is not a key, path, URL or format token. */
function isDisplayCopy(text: string): boolean {
  const value = text.replace(/\\[nt"]/g, " ").trim();
  if (value.length < 2 || !/[A-Za-zÀ-ÿ]/.test(value)) return false;
  if (/^[A-Z0-9_.]+$/.test(value)) return false; // STRING_KEY
  if (/^[a-z][a-zA-Z0-9]*$/.test(value) && /[A-Z]/.test(value)) return false; // camelCaseKey
  if (/^[a-z0-9_.-]+$/.test(value) && !value.includes(" ") && value.length > 12) return false; // snake/dotted keys
  if (/^(https?:|www\.|\/|#|%|\$\{|\\\()/.test(value)) return false;
  if (/^[\w-]+\.(png|jpg|json|xml|svg|pdf)$/i.test(value)) return false;
  if (/^\\\(.*\)$/.test(value) || /^\$\{.*\}$/.test(value)) return false; // pure interpolation
  return true;
}

export function findHardcodedCopy(platform: CopyHit["platform"], sources: RepoSource[], limit = 400): CopyHit[] {
  const patterns = platform === "iOS" ? SWIFT : KOTLIN;
  const hits: CopyHit[] = [];
  for (const source of sources) {
    if (platform === "iOS" ? !source.relativePath.endsWith(".swift") : !/\.(kt|java)$/.test(source.relativePath)) continue;
    const lines = source.text.split(/\r?\n/);
    // Preview code (@Preview functions, #Preview blocks, PreviewProvider types)
    // holds sample data, not what users see.
    let pendingPreview = false;
    let inPreview = false;
    for (let index = 0; index < lines.length && hits.length < limit; index++) {
      const line = lines[index];
      const trimmed = line.trim();
      if (/^@Preview\b/.test(trimmed)) pendingPreview = true;
      const fun = /\bfun\s+(?:<[^>]*>\s*)?(\w+)/.exec(trimmed);
      if (fun && platform === "Android") {
        inPreview = pendingPreview || /Preview/.test(fun[1]);
        pendingPreview = false;
      }
      if (platform === "iOS") {
        if (/^#Preview\b/.test(trimmed) || /^(?:\w+\s+)*struct\s+\w*Preview\w*|:\s*PreviewProvider\b/.test(trimmed)) inPreview = true;
        else if (/^(?:(?:public|private|internal|fileprivate|final|open)\s+)*(struct|class|enum|extension|func|actor)\s/.test(line)) inPreview = false;
      } else if (/^(?:(?:public|private|internal|data|sealed|abstract|open)\s+)*(class|object|interface)\s/.test(line)) {
        inPreview = false;
      }
      if (inPreview) continue;
      if (!trimmed.includes('"') || /^(\/\/|\*|\/\*|import\s|package\s)/.test(trimmed) || SKIP_LINE.test(line)) continue;
      const seen = new Set<string>();
      for (const pattern of patterns) {
        pattern.regex.lastIndex = 0;
        for (let match = pattern.regex.exec(line); match; match = pattern.regex.exec(line)) {
          const text = match[1];
          if (seen.has(text) || !isDisplayCopy(text)) continue;
          seen.add(text);
          hits.push({ platform, file: source.relativePath, line: index + 1, text, type: pattern.type, element: pattern.element });
        }
      }
    }
  }
  return hits;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\\[nt]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function screenOf(file: string): string {
  return path.basename(file).replace(/\.(kt|java|swift)$/, "");
}

const TYPE_ORDER: CopyType[] = ["button", "link", "title", "dialog", "input", "text"];

/**
 * The "Hard-coded copy" subsection the UI spec defines, from both platforms'
 * hits: the same literal on both platforms is one `Both` row; buttons and links
 * first. Capped at `maxRows`, with the remainder counted rather than dropped silently.
 */
export function hardcodedCopySection(android: CopyHit[], ios: CopyHit[], maxRows = 60): string {
  const iosByText = new Map<string, CopyHit[]>();
  for (const hit of ios) iosByText.set(normalize(hit.text), [...(iosByText.get(normalize(hit.text)) ?? []), hit]);
  const rows: { type: CopyType; screen: string; element: string; android: string; ios: string; on: string; cite: string }[] = [];
  const usedIos = new Set<CopyHit>();
  for (const hit of android) {
    const twin = iosByText.get(normalize(hit.text))?.find((candidate) => !usedIos.has(candidate));
    if (twin) usedIos.add(twin);
    rows.push({
      type: hit.type,
      screen: screenOf(hit.file),
      element: hit.element,
      android: `"${hit.text}"`,
      ios: twin ? `"${twin.text}"` : "—",
      on: twin ? "Both" : "Android",
      cite: twin ? `${hit.file}:${hit.line}; ${twin.file}:${twin.line}` : `${hit.file}:${hit.line}`,
    });
  }
  for (const hit of ios) {
    if (usedIos.has(hit)) continue;
    rows.push({ type: hit.type, screen: screenOf(hit.file), element: hit.element, android: "—", ios: `"${hit.text}"`, on: "iOS", cite: `${hit.file}:${hit.line}` });
  }
  if (rows.length === 0) {
    return "### Hard-coded copy on buttons and labels\n\nNo hard-coded user-visible copy was found in this module's matching source files on either platform.";
  }
  rows.sort((left, right) => TYPE_ORDER.indexOf(left.type) - TYPE_ORDER.indexOf(right.type) || left.screen.localeCompare(right.screen));
  const shown = rows.slice(0, maxRows);
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const counts = { Android: 0, iOS: 0, Both: 0 } as Record<string, number>;
  for (const row of rows) counts[row.on]++;
  return [
    "### Hard-coded copy on buttons and labels",
    "",
    `${rows.length} user-visible string(s) are written as literals in code instead of a string key or localized resource — Android only ${counts.Android}, iOS only ${counts.iOS}, both ${counts.Both}. Found by reading every matching source file of this module (not only the files the model read); \`—\` means no literal with that text on that platform.`,
    "",
    "| ID | Screen | Element | Type | Android Text Source | iOS Text Source | Hard-coded On | Citation |",
    "|---|---|---|---|---|---|---|---|",
    ...shown.map(
      (row, index) =>
        `| HC-${String(index + 1).padStart(2, "0")} | ${cell(row.screen)} | ${cell(row.element)} | ${row.type} | ${cell(row.android)} | ${cell(row.ios)} | ${row.on} | \`${row.cite.split("; ").join("`; `")}\` |`,
    ),
    ...(rows.length > maxRows ? ["", `${rows.length - maxRows} more hard-coded string(s) are not listed; buttons, links and titles are listed first.`] : []),
  ].join("\n");
}
