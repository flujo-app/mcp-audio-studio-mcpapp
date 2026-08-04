import { App } from "@modelcontextprotocol/ext-apps";

export interface StudioToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type ResultListener = (result: StudioToolResult) => void;

const embedded = window.parent !== window;
const app = embedded ? new App({ name: "MCP Audio Studio", version: "0.1.0" }) : undefined;
const listeners = new Set<ResultListener>();

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
