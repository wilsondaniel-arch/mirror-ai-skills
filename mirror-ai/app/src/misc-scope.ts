import { readSources, type RepoSource } from "./scan.ts";
import { MISC_MODULE_ID, type ModuleDef } from "./types.ts";

const TEST_PATH = /(^|\/)(test|tests|androidTest|testDebug|UITests|[A-Za-z]+Tests?)\//;
const TEST_FILE = /(Test|Tests|Spec|Mock|Fake|Stub)\.(kt|java|swift)$/;

export function isTestPath(relativePath: string): boolean {
  return TEST_PATH.test(relativePath) || TEST_FILE.test(relativePath);
}

/**
 * Whether a module's search terms pick this file. Same rule the budget runner
 * ranks by: the path names the module, or the code mentions it.
 */
export function claims(source: RepoSource, needles: string[]): boolean {
  const pathLower = source.relativePath.toLowerCase();
  return needles.some((needle) => pathLower.includes(needle.replace(/_/g, "")) || source.lower.includes(needle));
}

/** Production files on one side that none of `defs` picks. */
export function unclaimedFiles(root: string, defs: ModuleDef[]): string[] {
  const needleSets = defs.map((def) => def.keywords.map((keyword) => keyword.toLowerCase()).filter(Boolean));
  return readSources(root)
    .filter((source) => !isTestPath(source.relativePath))
    .filter((source) => !needleSets.some((needles) => needles.length > 0 && claims(source, needles)))
    .map((source) => source.relativePath)
    .sort();
}

/**
 * The whole-project audit's Miscellaneous section: every production file that
 * no common module claims — code of modules only one platform declares, of
 * modules missing from the module enum, and code that belongs to no module.
 * Null when every file is claimed.
 */
export function miscellaneousDef(androidPath: string, iosPath: string, commonDefs: ModuleDef[]): ModuleDef | null {
  const android = unclaimedFiles(androidPath, commonDefs);
  const ios = unclaimedFiles(iosPath, commonDefs);
  if (android.length === 0 && ios.length === 0) return null;
  return {
    id: MISC_MODULE_ID,
    label: "Miscellaneous",
    keywords: [],
    files: { android, ios },
  };
}

/** Business-logic-looking files first, so the budget reads them before plain views. */
const LOGIC_NAME = /(ViewModel|Repository|Repo|Service|UseCase|Interactor|Manager|Presenter|Controller|Api|Client|Validator|Helper|Util|Mapper|Store|Reducer|Handler|Coordinator|Router|Provider)\.(kt|java|swift)$/;

export function miscFileScore(source: RepoSource): number {
  let score = LOGIC_NAME.test(source.relativePath) ? 10 : 0;
  if (/https?:\/\/|@(GET|POST|PUT|DELETE|PATCH)\b|URLRequest|Retrofit|Alamofire/.test(source.text)) score += 5;
  if (/\bif\b|\bwhen\b|\bguard\b|\bswitch\b/.test(source.text)) score += 1;
  return score;
}
