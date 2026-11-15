/**
 * How a run's branch is shown everywhere (report indexes, report header, Jira, PR):
 * one name when Android and iOS were audited on the same branch, else both,
 * `Android: <branch> · iOS: <branch>`.
 */
export type BranchRun = { branch?: string; android?: { branch?: string } | string; ios?: { branch?: string } | string };

const side = (v: BranchRun["android"]) => (typeof v === "object" && v ? v.branch?.trim() : undefined) || undefined;

export function branches(run: BranchRun): { android?: string; ios?: string } {
  const fallback = run.branch?.trim() || undefined;
  return { android: side(run.android) ?? fallback, ios: side(run.ios) ?? fallback };
}

/** `feature/Sprint-21`, or `Android: feature/Sprint-21 · iOS: feature/Sprint-22` when they differ. */
export function branchLabel(run: BranchRun, opts: { short?: boolean; fallback?: string } = {}): string {
  const { android, ios } = branches(run);
  const name = (b: string) => (opts.short ? b.split("/").pop()! : b);
  if (android && ios && android !== ios) return `Android: ${name(android)} · iOS: ${name(ios)}`;
  const one = android ?? ios;
  return one ? name(one) : (opts.fallback ?? "");
}
