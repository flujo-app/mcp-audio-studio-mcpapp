import { App, type McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";

export interface StudioToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type ResultListener = (result: StudioToolResult) => void;

export const STUDIO_DISPLAY_MODES: McpUiDisplayMode[] = ["inline", "fullscreen", "pip"];

const embedded = window.parent !== window;
const app = embedded
  ? new App(
      { name: "MCP Audio Studio", version: "0.2.1" },
      { availableDisplayModes: STUDIO_DISPLAY_MODES },
    )
  : undefined;
const listeners = new Set<ResultListener>();

function browserDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (app) {
  app.ontoolresult = (result) => {
    for (const listener of listeners) listener(result as StudioToolResult);
  };
  void app.connect();
}

export function onHostResult(listener: ResultListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<StudioToolResult> {
  if (app) return await app.callServerTool({ name, arguments: args }) as StudioToolResult;
  const response = await fetch(`/api/tool/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const result = await response.json() as StudioToolResult & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Tool ${name} failed`);
  return result;
}

export async function updateModelContext(text: string): Promise<void> {
  if (!app) return;
  await app.updateModelContext({ content: [{ type: "text", text }] });
}

export async function downloadTextFile(name: string, mimeType: string, contents: string): Promise<boolean> {
  if (app) {
    const result = await app.downloadFile({
      contents: [{
        type: "resource",
        resource: { uri: `file:///${encodeURIComponent(name)}`, mimeType, text: contents },
      }],
    });
    return !result.isError;
  }
  browserDownload(new Blob([contents], { type: mimeType }), name);
  return true;
}

export async function downloadBase64File(name: string, mimeType: string, contents: string): Promise<boolean> {
  if (app) {
    const result = await app.downloadFile({
      contents: [{
        type: "resource",
        resource: { uri: `file:///${encodeURIComponent(name)}`, mimeType, blob: contents },
      }],
    });
    return !result.isError;
  }
  const binary = atob(contents);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  browserDownload(new Blob([bytes], { type: mimeType }), name);
  return true;
}
