import path from "node:path";

export function isManagedStorageKey(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("/")) return false;
  return !(
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  );
}

export function assertManagedStorageKey(value: string, label = "storageKey"): void {
  if (!isManagedStorageKey(value)) {
    throw new Error(
      `${label} must be a managed AdDroid storage key; local file paths must be imported before creating an ops PR`
    );
  }
}
