import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isEntrypoint } from "../src/server/is-entrypoint.js";

// Regression tests for `npx mcp-audio-studio` exiting immediately with
// "MCP error -32000: Connection closed" on Linux and macOS: the old guard compared
// import.meta.url to process.argv[1] as strings, which cannot match when npm/npx
// expose the bin as a symlink in node_modules/.bin (POSIX) instead of a .cmd shim.

const directories: string[] = [];

function scratch(prefix = "audio-entry-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("isEntrypoint", () => {
  it("matches when the module is launched by its real path", () => {
    const directory = scratch();
    const real = join(directory, "index.js");
    writeFileSync(real, "");
    expect(isEntrypoint(pathToFileURL(real).href, real)).toBe(true);
  });

  it("matches when the module is launched through a symlink (npx / node_modules/.bin)", () => {
    const directory = scratch();
    const real = join(directory, "index.js");
    writeFileSync(real, "");
    const link = join(directory, "mcp-audio-studio");
    try {
      symlinkSync(real, link, "file");
    } catch {
      // Windows without Developer Mode / SeCreateSymbolicLinkPrivilege.
      return;
    }
    expect(isEntrypoint(pathToFileURL(real).href, link)).toBe(true);
  });

  it("matches when the install path needs percent-encoding", () => {
    const directory = scratch("audio entry ünïcode-");
    const real = join(directory, "index.js");
    writeFileSync(real, "");
    const moduleUrl = pathToFileURL(real).href;
    expect(moduleUrl).toMatch(/%/); // guard the premise of the test
    expect(isEntrypoint(moduleUrl, real)).toBe(true);
  });

  it("does not match when the module is merely imported as a library", () => {
    const directory = scratch();
    const real = join(directory, "index.js");
    const other = join(directory, "consumer.js");
    writeFileSync(real, "");
    writeFileSync(other, "");
    expect(isEntrypoint(pathToFileURL(real).href, other)).toBe(false);
  });

  it("does not match without a process entry point", () => {
    const directory = scratch();
    const real = join(directory, "index.js");
    writeFileSync(real, "");
    expect(isEntrypoint(pathToFileURL(real).href, undefined)).toBe(false);
  });
});
