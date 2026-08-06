import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Decide whether this module is the process entry point.
 *
 * dist/index.js is both the package `bin` and its `main`/`exports`, so it needs a
 * guard - but the naive `import.meta.url` vs `process.argv[1]` string comparison
 * is wrong in ways that only show up outside Windows:
 *
 *   - npm and npx install bins as SYMLINKS in node_modules/.bin on Linux/macOS
 *     (Windows gets .cmd/.ps1 shims that pass the real path), so argv[1] is the
 *     link while import.meta.url is the real file.
 *   - macOS symlinks /tmp and Homebrew paths, so even direct launches differ.
 *   - import.meta.url is percent-encoded, so any path containing a space or a
 *     non-ASCII character never matches a raw argv[1].
 *
 * When the guard wrongly returns false the server exits 0 without a handshake and
 * MCP clients report "MCP error -32000: Connection closed". Comparing canonical
 * filesystem paths avoids every case above.
 */
export function isEntrypoint(
  moduleUrl: string,
  entryPath: string | undefined = process.argv[1],
): boolean {
  if (!entryPath) return false;

  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    // Not a file: URL - e.g. bundled into a single-file executable.
    return false;
  }

  return canonicalize(modulePath) === canonicalize(entryPath);
}

function canonicalize(pathLike: string): string {
  let candidate = pathLike;
  try {
    candidate = realpathSync(pathLike);
  } catch {
    // The path may not exist (deleted file, virtual entry); fall back to the input.
  }
  // Windows and macOS default to case-insensitive filesystems.
  return process.platform === "win32" || process.platform === "darwin"
    ? candidate.toLowerCase()
    : candidate;
}
