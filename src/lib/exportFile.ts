"use client";

/**
 * Hand the browser a JSON file to save.
 *
 * The object URL is revoked on the next macrotask rather than synchronously:
 * revoking in the same tick can abort the download in some browsers, and never
 * revoking leaks the blob for the lifetime of the document.
 */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Filesystem-safe filename for a session export. */
export function sessionExportFilename(simId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeId = simId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `oide-${safeId}-${stamp}.json`;
}
