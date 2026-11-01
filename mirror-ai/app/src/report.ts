import { readSnippet, type CodeSnippet } from "./snippet.ts";
import { isTestPath } from "./text.ts";
import type { ComparisonResult, Finding, Location, PlatformModule } from "./types.ts";

export interface RenderReportOptions {
  /** When false, omit @@compare code panes (smaller audit prompts). Default true. */
  includeCodeSnippets?: boolean;
}

export function renderReport(result: ComparisonResult, options: RenderReportOptions = {}): string {
  const includeCodeSnippets = options.includeCodeSnippets ?? true;
  const lines: string[] = [];
  lines.push("# Mirror AI comparison");
  lines.push("");
  lines.push(`- Android: \`${result.androidPath}\``);
  lines.push(`- iOS: \`${result.iosPath}\``);
  lines.push(`- Scope: ${result.scopeLabel}`);
  lines.push(`- Discovered modules: ${result.discoveredNames.join(", ") || "(none)"}`);
  if (result.omittedNames.length > 0) {
    lines.push(`- Not in this comparison: ${result.omittedNames.join(", ")}`);
  }
  if (result.workflow) {
    lines.push(`- Skill: ${result.workflow.skill}`);
    lines.push(`- Ruflo route: ${result.workflow.route}`);
  }
  lines.push("");
  const compactModules = result.scopeLabel.startsWith("selected modules:");
  if (!compactModules) {
    lines.push("## Modules");
    lines.push("");
    if (result.compared.length === 0) {
      lines.push("No modules were compared.");
      lines.push("");
    }
    for (const module of result.compared) {
      lines.push(`### ${module.name}`);
      lines.push("");
      lines.push("- Mapping basis:");
      for (const basis of module.mappingBasis) lines.push(`  - ${basis}`);
      writeSide(lines, "Android", module.android, 8);
      writeSide(lines, "iOS", module.ios, 8);
      lines.push("");
    }
  } else {
    lines.push("## Compared modules");
    lines.push("");
    for (const module of result.compared) {
      const androidCount = module.android?.files.length ?? 0;
      const iosCount = module.ios?.files.length ?? 0;
      lines.push(`- **${module.name}** — ${androidCount} Android file(s), ${iosCount} iOS file(s)`);
    }
    lines.push("");
  }
  lines.push("## Findings");
  lines.push("");
  if (result.findings.length === 0) {
    lines.push("No differences found.");
    lines.push("");
  }
  result.findings.forEach((finding, index) => {
    lines.push(`### ${index + 1}. ${finding.title}`);
    lines.push("");
    lines.push(`- Severity: ${finding.severity}`);
    lines.push(`- Status: ${finding.status}`);
    lines.push(`- Category: ${finding.category}`);
    lines.push(`- Module: ${finding.module}`);
    lines.push(`- Android: ${formatLocation(finding.android)}`);
    lines.push(`- iOS: ${formatLocation(finding.ios)}`);
    lines.push(`- Difference: ${finding.difference}`);
    lines.push(`- Evidence: ${finding.evidence}`);
    lines.push(`- Suggested fix: ${finding.suggestedFix}`);
    lines.push("");
    if (includeCodeSnippets) writeSideBySide(lines, result, finding);
  });
  if (result.missingRequests.length > 0) {
    lines.push("## Requested modules not found");
    lines.push("");
    for (const name of result.missingRequests) lines.push(`- ${name}`);
    lines.push("");
  }
  lines.push("## Analysis");
  lines.push("");
  lines.push(
    "Static comparison of screen titles, navigation routes, API endpoints, model fields, business rules, UI state copy, and call relationships. Keyword hints name a cluster after discovery; filenames are not matched.",
  );
  lines.push("");
  return lines.join("\n");
}

function writeSide(lines: string[], label: string, side: PlatformModule | null, maxFiles = 12): void {
  if (!side) {
    lines.push(`- ${label}: (no counterpart)`);
    return;
  }
  lines.push(`- ${label} files:`);
  const files = side.files.slice(0, maxFiles);
  for (const file of files) lines.push(`  - \`${file}\``);
  if (side.files.length > maxFiles) {
    lines.push(`  - … and ${side.files.length - maxFiles} more (scoped in findings below)`);
  }
  if (side.testFiles.length > 0) {
    lines.push(`- ${label} tests:`);
    for (const file of side.testFiles) lines.push(`  - \`${file}\``);
  }
  if (side.navigationFiles.length > 0) {
    lines.push(`- ${label} navigation:`);
    for (const file of side.navigationFiles) lines.push(`  - \`${file}\``);
  }
  if (side.routes.length > 0) lines.push(`- ${label} routes: ${side.routes.map((route) => `\`${route}\``).join(", ")}`);
  if (side.endpoints.length > 0) {
    lines.push(`- ${label} endpoints: ${side.endpoints.map((endpoint) => `\`${endpoint}\``).join(", ")}`);
  }
}

function writeSideBySide(lines: string[], result: ComparisonResult, finding: Finding): void {
  const module = result.compared.find((item) => item.name === finding.module) ?? null;
  lines.push("@@compare");
  writePane(lines, "android", readSnippet(result.androidPath, finding.android));
  writePane(lines, "ios", readSnippet(result.iosPath, finding.ios));
  lines.push(`api-android: ${apiText(module?.android ?? null)}`);
  lines.push(`api-ios: ${apiText(module?.ios ?? null)}`);
  lines.push("@@end");
  lines.push("");
}

function writePane(lines: string[], side: string, snippet: CodeSnippet | null): void {
  if (!snippet) {
    lines.push(`${side}: (no counterpart)`);
    lines.push("language: text");
    lines.push("start: 0");
    lines.push("```");
    lines.push("No code on this side.");
    lines.push("```");
    return;
  }
  lines.push(`${side}: ${snippet.file}:${snippet.line}`);
  lines.push(`language: ${snippet.language}`);
  lines.push(`start: ${snippet.startLine}`);
  lines.push("```" + snippet.language);
  lines.push(snippet.code);
  lines.push("```");
}

function apiText(side: PlatformModule | null): string {
  if (!side) return "(no counterpart)";
  const signals = side.signals.filter((signal) => !isTestPath(signal.file));
  const endpoints = [...new Set(signals.filter((signal) => signal.kind === "endpoint").map((signal) => signal.display))];
  const declared = signals.filter((signal) => signal.kind === "query-param" && signal.meta.declared === "true");
  const declaredNames = [...new Set(declared.map((signal) => signal.meta.name).filter(Boolean))];
  const params = declaredNames.map((name) => {
    const valued = signals.find(
      (signal) =>
        signal.kind === "query-param" &&
        signal.meta.name.toLowerCase() === name.toLowerCase() &&
        signal.meta.value,
    );
    return valued ? `${name}=${valued.meta.value}` : name;
  });
  if (endpoints.length === 0 && params.length === 0) return "No API call in this module.";
  return [endpoints.join(", "), params.join(", ")].filter(Boolean).join(" · ");
}

function formatLocation(location: Location): string {
  if (location.file === "(no counterpart)") return "(no counterpart)";
  return `\`${location.file}:${location.line}\``;
}
