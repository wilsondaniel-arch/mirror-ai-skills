/**
 * Static Jamaica snapshot reports are no longer appended to audits. Section 3 is
 * produced only by the api-skill pass against the current Android/iOS checkouts.
 */

/** @deprecated Kept for API compatibility; always empty. */
export function readApiDriftReference(_projectRoot: string): string {
  return "";
}

/** @deprecated Kept for API compatibility; always null. */
export function readApiDriftReferenceData(_projectRoot: string): unknown {
  return null;
}
