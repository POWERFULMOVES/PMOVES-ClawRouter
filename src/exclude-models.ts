/**
 * Exclude-models persistence module.
 *
 * Manages a user-configurable list of model IDs that the smart router
 * should never select. Stored as a sorted JSON array on disk.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { resolveModelAlias } from "./models.js";

const DEFAULT_FILE_PATH = join(homedir(), ".openclaw", "blockrun", "exclude-models.json");

/** mtime-validated cache — loadExcludeList runs on the proxy's hot request
 *  path, so skip the read+parse when the file hasn't changed. */
const loadCache = new Map<string, { mtimeMs: number; set: Set<string> }>();

/**
 * Load the exclude list from disk.
 * Returns an empty set if the file does not exist.
 */
export function loadExcludeList(filePath: string = DEFAULT_FILE_PATH): Set<string> {
  try {
    const mtimeMs = statSync(filePath).mtimeMs;
    const cached = loadCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      // Copy: callers may mutate the returned set
      return new Set(cached.set);
    }
    const raw = readFileSync(filePath, "utf-8");
    const arr: unknown = JSON.parse(raw);
    const set = Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === "string"))
      : new Set<string>();
    loadCache.set(filePath, { mtimeMs, set });
    return new Set(set);
  } catch {
    loadCache.delete(filePath);
    return new Set();
  }
}

/**
 * Save a set of model IDs to disk as a sorted JSON array.
 */
function saveExcludeList(set: Set<string>, filePath: string): void {
  const sorted = [...set].sort();
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(sorted, null, 2) + "\n", "utf-8");
  // Same-millisecond write+read could alias on mtime — drop the entry instead
  loadCache.delete(filePath);
}

/**
 * Add a model to the exclude list.
 * Resolves aliases before persisting.
 * @returns The resolved model ID.
 */
export function addExclusion(model: string, filePath: string = DEFAULT_FILE_PATH): string {
  const resolved = resolveModelAlias(model);
  const set = loadExcludeList(filePath);
  set.add(resolved);
  saveExcludeList(set, filePath);
  return resolved;
}

/**
 * Remove a model from the exclude list.
 * Resolves aliases before removing.
 * @returns true if the model was present and removed, false otherwise.
 */
export function removeExclusion(model: string, filePath: string = DEFAULT_FILE_PATH): boolean {
  const resolved = resolveModelAlias(model);
  const set = loadExcludeList(filePath);
  const had = set.delete(resolved);
  if (had) {
    saveExcludeList(set, filePath);
  }
  return had;
}

/**
 * Clear the entire exclude list.
 */
export function clearExclusions(filePath: string = DEFAULT_FILE_PATH): void {
  saveExcludeList(new Set(), filePath);
}
