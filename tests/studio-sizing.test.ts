import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression tests for the studio rendering as a ~120px sliver in MCP App hosts.
//
// Hosts embed an inline app in a short placeholder iframe (FLUJO uses 200px) and
// enlarge it only when the app sends `ui/notifications/size-changed`. The ext-apps
// SDK measures the document element and watches html/body with a ResizeObserver, so
// `height: 100%` broke sizing twice over: the studio reported the host's placeholder
// height back to the host, and html/body could then never change size, so no later
// notification was ever sent - it stayed at its loading-screen height forever.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src", "web", "studio.css"), "utf8");

function rule(selector: string): string {
  const match = css.match(new RegExp(`(^|\\n)${selector}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`No CSS rule found for "${selector}"`);
  return match[2];
}

describe("studio host sizing", () => {
  it("lets the document be sized by its content, not by the host frame", () => {
    const document = rule("html, body, #root");
    expect(document).toContain("min-height: 100%");
    expect(document).not.toMatch(/[^-]height:\s*100%/);
  });

  it("keeps the shell tied to the frame's own height so it settles instead of oscillating", () => {
    // 100vh inside an iframe is the frame's height: once the host grants the
    // requested size, re-measuring returns the same number.
    const shell = rule("\\.studio-shell");
    expect(shell).toMatch(/height:\s*100vh/);
    expect(shell).toMatch(/min-height:\s*650px/);
  });

  it("reports a full-size studio from the very first measurement", () => {
    // The first size notification is sent while the loading screen is on screen.
    const loading = rule("\\.loading-screen");
    expect(loading).toMatch(/min-height:\s*650px/);
    expect(loading).not.toMatch(/[^-]height:\s*100%/);
  });
});
