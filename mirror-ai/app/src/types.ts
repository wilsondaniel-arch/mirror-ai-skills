export type Language = "kotlin" | "java" | "swift";

export type Role = "production" | "test";

export type SignalKind =
  | "screen-title"
  | "route"
  | "endpoint"
  | "query-param"
  | "model-field"
  | "business-rule"
  | "constant"
  | "ui-copy"
  | "ui-widget"
  | "symbol"
  | "reference"
  | "test";

export interface Signal {
  kind: SignalKind;
  key: string;
  display: string;
  file: string;
  line: number;
  excerpt: string;
  meta: Record<string, string>;
}

export interface SourceUnit {
  path: string;
  language: Language;
  role: Role;
  signals: Signal[];
}

export type Severity = "high" | "medium" | "low";

export type FindingStatus = "confirmed mismatch" | "needs runtime verification";

export type Category =
  | "UI and design parity"
  | "Business logic and user flows"
  | "API and data parity"
  | "Test coverage and quality";

export interface Location {
  file: string;
  line: number;
}

export interface Finding {
  severity: Severity;
  status: FindingStatus;
  category: Category;
  module: string;
  title: string;
  android: Location;
  ios: Location;
  difference: string;
  evidence: string;
  suggestedFix: string;
}

export interface PlatformModule {
  label: string;
  labelBasis: string;
  files: string[];
  testFiles: string[];
  navigationFiles: string[];
  signals: Signal[];
  screenTitles: string[];
  endpoints: string[];
  modelFields: string[];
  routes: string[];
  callEdges: string[];
}

export interface MappedModule {
  name: string;
  android: PlatformModule | null;
  ios: PlatformModule | null;
  mappingBasis: string[];
}

/** One module read out of a platform's module enum, with the words that find its code. */
export interface ModuleDef {
  id: string;
  label: string;
  keywords: string[];
  /**
   * The exact files to read, per platform (paths relative to each repo root),
   * for a module that is not found by keywords — the whole-project audit's
   * Miscellaneous section. When set, `keywords` is not used to pick files.
   */
  files?: { android: string[]; ios: string[] };
}

/** Id of the whole-project audit's last section: code no common module claims. */
export const MISC_MODULE_ID = "miscellaneous";

/** Module-by-enum (default UI) or a single whole-repository audit. */
export type ComparisonMode = "module" | "repository";

export const REPOSITORY_MODULE_KEY = "full-app";

export function repositoryModuleDef(): ModuleDef {
  return { id: REPOSITORY_MODULE_KEY, label: "Full application", keywords: [] };
}

export type Scope =
  | { kind: "full" }
  | { kind: "modules"; names: string[] }
  | { kind: "enum-modules"; defs: ModuleDef[] };

export interface WorkflowNote {
  skill: string;
  route: string;
}

export interface ComparisonResult {
  androidPath: string;
  iosPath: string;
  scopeLabel: string;
  compared: MappedModule[];
  discoveredNames: string[];
  omittedNames: string[];
  missingRequests: string[];
  findings: Finding[];
  workflow?: WorkflowNote;
}
