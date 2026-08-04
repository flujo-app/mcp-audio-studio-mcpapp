import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioRuntime } from "../src/server/actions.js";
import { createStudioMcpServer, STUDIO_RESOURCE_URI } from "../src/server/mcp.js";

const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.allSettled(closeables.splice(0).map((item) => item.close()));
});

describe("MCP surface", () => {
  it("advertises the complete tool surface and MCP App resource", async () => {
    const runtime = await createStudioRuntime();
    const server = createStudioMcpServer(runtime);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names.length).toBeGreaterThanOrEqual(20);
    expect(names).toEqual(expect.arrayContaining([
      "studio_ui", "get_project", "set_transport", "set_steps", "add_audio_clip",
      "set_mixer", "set_equalizer", "add_effect", "add_plugin", "upsert_automation", "render_audio",
    ]));
    const studioTool = tools.tools.find((tool) => tool.name === "studio_ui");
    expect(studioTool?._meta?.ui).toMatchObject({ resourceUri: STUDIO_RESOURCE_URI });

    const result = await client.callTool({ name: "studio_ui", arguments: {} });
    expect(result.structuredContent).toHaveProperty("project");
    const resource = await client.readResource({ uri: STUDIO_RESOURCE_URI });
    expect(resource.contents[0]).toMatchObject({ uri: STUDIO_RESOURCE_URI, mimeType: "text/html;profile=mcp-app" });
    expect("text" in resource.contents[0] ? resource.contents[0].text : "").toContain("Audio Studio test UI");
  });
});
