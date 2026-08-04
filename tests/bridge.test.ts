import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appConstructor: vi.fn(),
  connect: vi.fn(async () => {}),
  downloadFile: vi.fn(async () => ({ isError: false })),
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    ontoolresult?: (result: unknown) => void;

    constructor(appInfo: unknown, capabilities: unknown) {
      mocks.appConstructor(appInfo, capabilities);
    }

    connect = mocks.connect;
    downloadFile = mocks.downloadFile;
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("MCP App bridge", () => {
  it("declares fullscreen and picture-in-picture display support", async () => {
    vi.stubGlobal("window", { parent: {} });

    const { STUDIO_DISPLAY_MODES, downloadTextFile } = await import("../src/web/bridge.js");

    expect(STUDIO_DISPLAY_MODES).toEqual(["inline", "fullscreen", "pip"]);
    expect(mocks.appConstructor).toHaveBeenCalledWith(
      { name: "MCP Audio Studio", version: "0.1.0" },
      { availableDisplayModes: ["inline", "fullscreen", "pip"] },
    );
    expect(mocks.connect).toHaveBeenCalledOnce();

    await expect(downloadTextFile("session.audio-studio.json", "application/json", "{\"name\":\"Session\"}"))
      .resolves.toBe(true);
    expect(mocks.downloadFile).toHaveBeenCalledWith({
      contents: [{
        type: "resource",
        resource: {
          uri: "file:///session.audio-studio.json",
          mimeType: "application/json",
          text: "{\"name\":\"Session\"}",
        },
      }],
    });
  });
});
