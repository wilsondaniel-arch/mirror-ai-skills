import { readSources } from "./scan.ts";
import type { Language, ModuleDef } from "./types.ts";

/** An enum has to carry at least this many constants before it can be a module catalog. */
const MIN_CASES = 5;
/** Below this many shared constants, two enums are not the same catalog. */
const MIN_OVERLAP = 3;
const MODULE_NAME = /(module|redirect|destination|target|route|section|feature|screen|deeplink|cta|navigation|tab)/i;

/**
 * Enums that name in-app module / redirection targets (CTA `targetModule`, deep links).
 * Not CMS string catalogs (`StringKeys`, `DynamicLabels`).
 */
const MODULE_REDIRECT_ENUM_NAMES = new Set([
  "CTAModuleType",
  "RedirectionTarget",
  "NavigationTarget",
  "StoreModuleType",
  "StoreDestination",
]);

/** CMS copy enums — never the module list for Mirror AI. */
const EXCLUDED_CATALOG_ENUM_NAMES = new Set(["StringKeys", "DynamicLabels"]);
const JVM_RESERVED = new Set([
  "companion",
  "object",
  "fun",
  "val",
  "var",
  "class",
  "const",
  "init",
  "override",
  "private",
  "public",
  "internal",
  "protected",
  "static",
  "final",
]);

export interface EnumCase {
  /** Serial name or raw value when the source declares one, else the constant name. */
  id: string;
  name: string;
  line: number;
}

export interface EnumDecl {
  enumName: string;
  file: string;
  line: number;
  language: Language;
  cases: EnumCase[];
}

export interface ModuleSide {
  enumName: string;
  caseName: string;
  id: string;
  file: string;
  line: number;
}

export interface ModuleRow {
  key: string;
  id: string;
  label: string;
  android: ModuleSide | null;
  ios: ModuleSide | null;
}

export interface EnumSource {
  enumName: string;
  file: string;
  line: number;
  cases: number;
}

export interface ModuleCatalog {
  common: ModuleRow[];
  androidOnly: ModuleRow[];
  iosOnly: ModuleRow[];
  androidSource: EnumSource | null;
  iosSource: EnumSource | null;
}

/** `BILL_PAYMENT`, `billPayment` and `Bill Payment` all have to land on one key. */
export function moduleKey(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildModuleCatalog(androidPath: string, iosPath: string): ModuleCatalog {
  const picked = selectModuleEnums(scanRepo(androidPath), scanRepo(iosPath));
  const rows = new Map<string, ModuleRow>();
  if (picked.android) collect(rows, picked.android, "android");
  if (picked.ios) collect(rows, picked.ios, "ios");
  const all = [...rows.values()].sort((left, right) => left.label.localeCompare(right.label));
  return {
    common: all.filter((row) => row.android && row.ios),
    androidOnly: all.filter((row) => row.android && !row.ios),
    iosOnly: all.filter((row) => row.ios && !row.android),
    androidSource: sourceOf(picked.android),
    iosSource: sourceOf(picked.ios),
  };
}

export function moduleDefs(rows: ModuleRow[]): ModuleDef[] {
  return rows.map((row) => ({ id: row.key, label: row.label, keywords: keywordsFor(row) }));
}

export function scanRepo(root: string): EnumDecl[] {
  const decls: EnumDecl[] = [];
  for (const source of readSources(root)) {
    decls.push(...findEnums(source.relativePath, source.text));
  }
  return decls;
}

export function findEnums(file: string, rawText: string): EnumDecl[] {
  const language = languageOf(file);
  if (!language) return [];
  if (!/\benum\b/.test(rawText)) return [];
  const text = maskNoise(rawText, language);
  const lineStarts = indexLines(text);
  const decls: EnumDecl[] = [];
  const declaration = /\benum\b(?:\s+class\b)?\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(text)) !== null) {
    const open = text.indexOf("{", match.index + match[0].length);
    // A header longer than this is not an enum header; it is an unrelated `{` further down.
    if (open < 0 || open - match.index > 400) continue;
    const close = blockEnd(text, open);
    if (close < 0) continue;
    const body = text.slice(open + 1, close);
    const cases =
      language === "swift"
        ? swiftCases(body, open + 1, lineStarts)
        : jvmCases(body, open + 1, lineStarts);
    if (cases.length === 0) continue;
    decls.push({
      enumName: match[1],
      file,
      line: lineOf(lineStarts, match.index),
      language,
      cases,
    });
  }
  return decls;
}

/**
 * Picks the one enum per platform that is the module catalog. The signal that
 * beats any naming convention is overlap: the two catalogs name the same
 * modules. Naming only breaks ties, and a lone platform falls back to it.
 */
export function selectModuleEnums(
  androidEnums: EnumDecl[],
  iosEnums: EnumDecl[],
): { android: EnumDecl | null; ios: EnumDecl | null } {
  const redirectPair = bestOverlapPair(moduleRedirectCatalogs(androidEnums), moduleRedirectCatalogs(iosEnums), 1000);
  if (redirectPair) return redirectPair;

  const android = candidates(androidEnums.filter((decl) => !isExcludedCatalogEnum(decl)));
  const ios = candidates(iosEnums.filter((decl) => !isExcludedCatalogEnum(decl)));
  const pair = bestOverlapPair(android, ios, 0);
  if (pair) return pair;
  return { android: largest(android), ios: largest(ios) };
}

function isExcludedCatalogEnum(decl: EnumDecl): boolean {
  if (EXCLUDED_CATALOG_ENUM_NAMES.has(decl.enumName)) return true;
  if (decl.enumName === "StringKeys" && /StringKeys\.kt$/i.test(decl.file)) return true;
  if (decl.enumName === "DynamicLabels" && /Enum\.swift$/i.test(decl.file)) return true;
  return false;
}

function isModuleRedirectCatalog(decl: EnumDecl): boolean {
  if (isExcludedCatalogEnum(decl)) return false;
  if (MODULE_REDIRECT_ENUM_NAMES.has(decl.enumName)) return true;
  if (decl.enumName === "RedirectionTarget" && /RedirectionTarget\.swift$/i.test(decl.file)) return true;
  if (decl.enumName === "NavigationTarget" && /NavigationTarget\.swift$/i.test(decl.file)) return true;
  return false;
}

function moduleRedirectCatalogs(decls: EnumDecl[]): EnumDecl[] {
  return candidates(decls.filter(isModuleRedirectCatalog));
}

function bestOverlapPair(
  android: EnumDecl[],
  ios: EnumDecl[],
  redirectBonus: number,
): { android: EnumDecl; ios: EnumDecl } | null {
  let best: { android: EnumDecl; ios: EnumDecl; score: number } | null = null;
  for (const left of android) {
    const leftKeys = keySet(left);
    for (const right of ios) {
      let hits = 0;
      for (const key of keySet(right)) {
        if (leftKeys.has(key)) hits += 1;
      }
      if (hits < MIN_OVERLAP) continue;
      const score = hits * 10 + nameBonus(left) + nameBonus(right) + redirectBonus;
      if (!best || score > best.score) best = { android: left, ios: right, score };
    }
  }
  return best ? { android: best.android, ios: best.ios } : null;
}

function candidates(decls: EnumDecl[]): EnumDecl[] {
  return decls.filter((decl) => decl.cases.length >= MIN_CASES);
}

const keyCache = new WeakMap<EnumDecl, Set<string>>();

function keySet(decl: EnumDecl): Set<string> {
  const cached = keyCache.get(decl);
  if (cached) return cached;
  const keys = new Set(decl.cases.map((item) => moduleKey(item.id)).filter(Boolean));
  keyCache.set(decl, keys);
  return keys;
}

function nameBonus(decl: EnumDecl): number {
  return MODULE_NAME.test(decl.enumName) ? 5 : 0;
}

function largest(decls: EnumDecl[]): EnumDecl | null {
  let best: { decl: EnumDecl; score: number } | null = null;
  for (const decl of decls) {
    const score = nameBonus(decl) * 20 + decl.cases.length;
    if (!best || score > best.score) best = { decl, score };
  }
  return best?.decl ?? null;
}

function collect(rows: Map<string, ModuleRow>, decl: EnumDecl, side: "android" | "ios"): void {
  for (const item of decl.cases) {
    const key = moduleKey(item.id);
    if (!key) continue;
    const entry: ModuleSide = {
      enumName: decl.enumName,
      caseName: item.name,
      id: item.id,
      file: decl.file,
      line: item.line,
    };
    const existing = rows.get(key);
    if (existing) {
      // Two constants can share a key (`SHOP` and a legacy `Shop`); the first wins.
      if (existing[side]) continue;
      existing[side] = entry;
      if (side === "android") {
        existing.id = item.id;
        existing.label = humanize(item.id);
      }
      continue;
    }
    rows.set(key, {
      key,
      id: item.id,
      label: humanize(item.id),
      android: side === "android" ? entry : null,
      ios: side === "ios" ? entry : null,
    });
  }
}

function sourceOf(decl: EnumDecl | null): EnumSource | null {
  if (!decl) return null;
  return { enumName: decl.enumName, file: decl.file, line: decl.line, cases: decl.cases.length };
}

function keywordsFor(row: ModuleRow): string[] {
  const seeds = [row.android?.id, row.android?.caseName, row.ios?.id, row.ios?.caseName];
  const keywords = new Set<string>();
  for (const seed of seeds) {
    if (!seed) continue;
    keywords.add(seed);
    keywords.add(pascalCase(seed));
  }
  return [...keywords].filter((keyword) => keyword.length >= 4);
}

function pascalCase(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

function humanize(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return id;
  return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(" ");
}

function languageOf(file: string): Language | null {
  if (/\.(kt|kts)$/.test(file)) return "kotlin";
  if (/\.java$/.test(file)) return "java";
  if (/\.swift$/.test(file)) return "swift";
  return null;
}

/**
 * Blanks comments, and blanks only the structural characters inside string
 * literals. Brace and comma scanning then cannot be thrown off by text, while
 * `@SerialName("X")` and `= "X"` stay readable.
 */
function maskNoise(text: string, language: Language): string {
  const out = text.split("");
  const length = text.length;
  let index = 0;
  const blankStructure = (at: number) => {
    if (/[{}()[\];,/"']/.test(text[at])) out[at] = " ";
  };
  const readString = (quote: string, size: number) => {
    index += size;
    while (index < length) {
      if (text.startsWith(quote, index)) {
        index += size;
        return;
      }
      if (size === 1 && text[index] === "\n") return;
      if (text[index] === "\\") {
        out[index] = " ";
        if (index + 1 < length && text[index + 1] !== "\n") out[index + 1] = " ";
        index += 2;
        continue;
      }
      blankStructure(index);
      index += 1;
    }
  };
  while (index < length) {
    if (text.startsWith("//", index)) {
      while (index < length && text[index] !== "\n") {
        out[index] = " ";
        index += 1;
      }
      continue;
    }
    if (text.startsWith("/*", index)) {
      out[index] = " ";
      out[index + 1] = " ";
      index += 2;
      while (index < length && !text.startsWith("*/", index)) {
        if (text[index] !== "\n") out[index] = " ";
        index += 1;
      }
      if (index < length) {
        out[index] = " ";
        out[index + 1] = " ";
        index += 2;
      }
      continue;
    }
    if (text.startsWith('"""', index)) {
      readString('"""', 3);
      continue;
    }
    if (text[index] === '"') {
      readString('"', 1);
      continue;
    }
    if (language !== "swift" && text[index] === "'") {
      readString("'", 1);
      continue;
    }
    index += 1;
  }
  return out.join("");
}

function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Kotlin and Java list constants first and end them with a top-level `;`. */
function jvmCases(body: string, offset: number, lineStarts: number[]): EnumCase[] {
  const head = body.slice(0, topLevelIndex(body, ";"));
  const cases: EnumCase[] = [];
  let depth = 0;
  let start = 0;
  const pieces: { text: string; start: number }[] = [];
  for (let index = 0; index < head.length; index++) {
    const char = head[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      pieces.push({ text: head.slice(start, index), start });
      start = index + 1;
    }
  }
  pieces.push({ text: head.slice(start), start });
  for (const piece of pieces) {
    const serial = /@SerialName\s*\(\s*"([^"\n]*)"/.exec(piece.text)?.[1] ?? "";
    // Equal-length blanking keeps every index aligned with the original piece.
    const stripped = piece.text.replace(
      /@[A-Za-z_][A-Za-z0-9_.]*\s*(\([^)]*\))?/g,
      (annotation) => " ".repeat(annotation.length),
    );
    const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(stripped);
    if (!name) continue;
    if (JVM_RESERVED.has(name[1])) continue;
    const at = offset + piece.start + (name.index ?? 0) + name[0].length - name[1].length;
    cases.push({ id: serial || name[1], name: name[1], line: lineOf(lineStarts, at) });
  }
  return cases;
}

/** Swift spells each constant `case name` at the top level of the enum body. */
function swiftCases(body: string, offset: number, lineStarts: number[]): EnumCase[] {
  const cases: EnumCase[] = [];
  let depth = 0;
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === "{" || char === "(" || char === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 0 && body.startsWith("case", index) && isCaseKeyword(body, index)) {
      const lineEnd = body.indexOf("\n", index);
      const end = lineEnd < 0 ? body.length : lineEnd;
      readSwiftCaseLine(body.slice(index + 4, end), offset + index + 4, lineStarts, cases);
      index = end;
      continue;
    }
    index += 1;
  }
  return cases;
}

function isCaseKeyword(body: string, index: number): boolean {
  const before = index === 0 ? " " : body[index - 1];
  const after = body[index + 4] ?? " ";
  return !/[A-Za-z0-9_.]/.test(before) && /\s/.test(after);
}

function readSwiftCaseLine(
  line: string,
  offset: number,
  lineStarts: number[],
  cases: EnumCase[],
): void {
  let depth = 0;
  let start = 0;
  const parts: { text: string; start: number }[] = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "(" || char === "[" || char === "<") depth += 1;
    else if (char === ")" || char === "]" || char === ">") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push({ text: line.slice(start, index), start });
      start = index + 1;
    }
  }
  parts.push({ text: line.slice(start), start });
  for (const part of parts) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*"([^"]*)")?/.exec(part.text);
    if (!match?.[1]) continue;
    const at = offset + part.start + (match[0].length - match[0].trimStart().length);
    cases.push({ id: match[2] || match[1], name: match[1], line: lineOf(lineStarts, at) });
  }
}

function topLevelIndex(body: string, char: string): number {
  let depth = 0;
  for (let index = 0; index < body.length; index++) {
    const current = body[index];
    if (current === "{" || current === "(" || current === "[") depth += 1;
    else if (current === "}" || current === ")" || current === "]") depth -= 1;
    else if (current === char && depth === 0) return index;
  }
  return body.length;
}

function indexLines(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineOf(lineStarts: number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}
