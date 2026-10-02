import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isUncPath, isWindowsPath, normalizeNativePath } from "./platform.js";

// Directory listing for the folder picker a remote Athena shows when you open a
// workspace on this machine (GET /fs/dirs). Names of folders only: no files, no
// contents. Kept free of any `electron` import so it can be unit tested.

export type DirectoryEntry = { name: string; path: string };

export type DirectoryListing = {
  path: string;
  parent: string | null;
  home: string;
  dirs: DirectoryEntry[];
  truncated: boolean;
};

export type ListDirectoriesOptions = {
  includeHidden?: boolean;
  limit?: number;
  home?: string;
};

const DEFAULT_LIMIT = 500;

export async function listDirectories(requested: unknown, options: ListDirectoriesOptions = {}): Promise<DirectoryListing> {
  const home = options.home ?? os.homedir();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 5_000));
  const raw = typeof requested === "string" && requested.trim() ? requested.trim() : home;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) throw new Error("Folder must be a local path, not a URL.");
  if (isUncPath(raw)) throw new Error("Network (UNC) folders are not supported.");
  if (!path.isAbsolute(raw) && !isWindowsPath(raw)) throw new Error("Folder must be an absolute path.");

  const resolved = await fs.realpath(normalizeNativePath(raw));
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${resolved}`);

  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const dirs: DirectoryEntry[] = [];
  for (const entry of entries) {
    if (!options.includeHidden && entry.name.startsWith(".")) continue;
    const entryPath = path.join(resolved, entry.name);
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      isDirectory = await fs.stat(entryPath).then((target) => target.isDirectory(), () => false);
    }
    if (isDirectory) dirs.push({ name: entry.name, path: entryPath });
  }
  dirs.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }));
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    home,
    dirs: dirs.slice(0, limit),
    truncated: dirs.length > limit,
  };
}
