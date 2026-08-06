import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { StudioRuntime } from "./actions.js";
import studioHtml from "virtual:studio-html";

export const STUDIO_RESOURCE_URI = "ui://audio-studio/studio-v1.html";

export function createStudioMcpServer(runtime: StudioRuntime): McpServer {
  const server = new McpServer({
    name: "MCP Audio Studio",
    version: "0.2.1",
    description: "Interactive digital audio workstation with sequencing, mixing, effects, automation, plugins, and WAV rendering.",
  });

  registerAppResource(
    server,
    "Audio Studio UI",
    STUDIO_RESOURCE_URI,
    {
      description: "Complete interactive Audio Studio DAW interface.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [{
        uri: STUDIO_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: studioHtml,
        _meta: {
          ui: {
            prefersBorder: false,
            permissions: { microphone: {}, clipboardWrite: {} },
          },
        },
      }],
    }),
  );

  for (const [name, action] of runtime.actions) {
    const isStudioUi = name === "studio_ui";
    registerAppTool(
      server,
      name,
      {
        title: action.title,
        description: action.description,
        inputSchema: action.schema.shape,
        annotations: {
          readOnlyHint: action.readOnly ?? false,
          destructiveHint: action.destructive ?? false,
          idempotentHint: action.readOnly ?? false,
          openWorldHint: false,
        },
        _meta: {
          ui: {
            ...(isStudioUi ? { resourceUri: STUDIO_RESOURCE_URI } : {}),
            visibility: ["model", "app"],
          },
          "openai/outputTemplate": isStudioUi ? STUDIO_RESOURCE_URI : undefined,
          "openai/toolInvocation/invoking": `${action.title}…`,
          "openai/toolInvocation/invoked": `${action.title} complete.`,
        },
      },
      async (input) => runtime.call(name, input) as never,
    );
  }

  return server;
}
