import { compareRepos } from "./index.ts";
import { renderReport } from "./report.ts";
import type { ModuleDef } from "./types.ts";

/** Compact static-matcher leads for one module (no @@compare code blocks). */
export function leadsForModule(androidPath: string, iosPath: string, def: ModuleDef): string {
  return renderReport(
    compareRepos({
      androidPath,
      iosPath,
      scope: { kind: "enum-modules", defs: [def] },
    }),
    { includeCodeSnippets: false },
  );
}

export function buildModuleLeadsMap(
  androidPath: string,
  iosPath: string,
  defs: ModuleDef[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const def of defs) {
    map[def.id] = leadsForModule(androidPath, iosPath, def);
  }
  return map;
}

/** Whole-repo comparison leads without side-by-side snippets. */
export function leadsForRepository(androidPath: string, iosPath: string): string {
  return renderReport(
    compareRepos({
      androidPath,
      iosPath,
      scope: { kind: "full" },
    }),
    { includeCodeSnippets: false },
  );
}
