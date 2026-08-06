import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import selfsigned from "selfsigned";
import studioHtml from "virtual:studio-html";
import { createStudioRuntime, type StudioRuntime } from "./actions.js";
import { createStudioMcpServer } from "./mcp.js";

type Mode = "stdio" | "http" | "https";

function parseArguments(argv: string[]): { mode: Mode; port: number; host: string; dataPath?: string } {
  const mode: Mode = argv.includes("--https") ? "https" : argv.includes("--http") ? "http" : "stdio";
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    mode,
    port: Number(valueAfter("--port") ?? process.env.MCP_AUDIO_STUDIO_PORT ?? 3100),
    host: valueAfter("--host") ?? process.env.MCP_AUDIO_STUDIO_HOST ?? "127.0.0.1",
    dataPath: valueAfter("--data") ?? process.env.MCP_AUDIO_STUDIO_DATA,
  };
}

async function handleMcpRequest(runtime: StudioRuntime, request: express.Request, response: express.Response): Promise<void> {
  const server = createStudioMcpServer(runtime);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, request.body);
}

async function createHttpsOptions(): Promise<https.ServerOptions> {
  const certPath = process.env.MCP_AUDIO_STUDIO_TLS_CERT;
  const keyPath = process.env.MCP_AUDIO_STUDIO_TLS_KEY;
  if (certPath && keyPath) {
    return { cert: await readFile(certPath), key: await readFile(keyPath) };
  }
  const generated = selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    days: 7,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [
      { type: 2, value: "localhost" },
      { type: 7, ip: "127.0.0.1" },
    ] }],
  });
  console.error("[audio-studio] No TLS certificate configured; using an ephemeral self-signed localhost certificate.");
  return { cert: generated.cert, key: generated.private };
}

async function startWeb(runtime: StudioRuntime, mode: "http" | "https", host: string, port: number): Promise<void> {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: true, exposedHeaders: ["Mcp-Session-Id"] }));
  app.use(express.json({ limit: "64mb" }));
  app.get("/", (_request, response) => response.type("html").send(studioHtml));
  app.get("/health", (_request, response) => response.json({ ok: true, name: "mcp-audio-studio", revision: runtime.store.snapshot().revision }));
  app.post("/api/tool/:name", async (request, response) => {
    try {
      response.json(await runtime.call(request.params.name, request.body));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/renders/:id", (request, response) => {
    const render = runtime.renders.get(request.params.id);
    if (!render) return response.status(404).json({ error: "Render not found or expired." });
    response.setHeader("Content-Type", render.mimeType);
    response.setHeader("Content-Disposition", `attachment; filename=\"${render.name}\"`);
    response.send(render.buffer);
  });
  app.post("/mcp", (request, response, next) => {
    void handleMcpRequest(runtime, request, response).catch(next);
  });
  app.get("/mcp", (_request, response) => response.status(405).set("Allow", "POST").json({ error: "Use POST for stateless Streamable HTTP." }));
  app.delete("/mcp", (_request, response) => response.status(405).set("Allow", "POST").json({ error: "Use POST for stateless Streamable HTTP." }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error("[audio-studio] HTTP error:", error);
    if (!response.headersSent) response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const server = mode === "https"
    ? https.createServer(await createHttpsOptions(), app)
    : http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.error(`[audio-studio] ${mode.toUpperCase()} MCP endpoint: ${mode}://${host}:${port}/mcp`);
  console.error(`[audio-studio] Standalone studio: ${mode}://${host}:${port}/`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log("mcp-audio-studio 0.2.1");
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`MCP Audio Studio 0.2.1

Usage:
  mcp-audio-studio --stdio                 Start the MCP stdio transport (default)
  mcp-audio-studio --http [--port 3100]    Start Streamable HTTP and the standalone UI
  mcp-audio-studio --https [--port 3100]   Start HTTPS (self-signed unless certs are configured)

Options:
  --host <address>   Bind address (default: 127.0.0.1)
  --port <number>    HTTP/HTTPS port (default: 3100)
  --data <path>      Persist the project to a JSON file
  --version          Print the version
  --help             Show this help

Environment:
  MCP_AUDIO_STUDIO_HOST, MCP_AUDIO_STUDIO_PORT, MCP_AUDIO_STUDIO_DATA
  MCP_AUDIO_STUDIO_TLS_CERT, MCP_AUDIO_STUDIO_TLS_KEY`);
    return;
  }
  const options = parseArguments(argv);
  const runtime = await createStudioRuntime(options.dataPath);
  if (options.mode === "stdio") {
    const server = createStudioMcpServer(runtime);
    await server.connect(new StdioServerTransport());
    return;
  }
  await startWeb(runtime, options.mode, options.host, options.port);
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1") === process.argv[1].replaceAll("\\", "/");
const runningAsCompiledBunExecutable = Boolean((globalThis as Record<string, unknown>).Bun)
  && !/\.[cm]?[jt]sx?$/i.test(process.argv[1] ?? "");
if (invokedDirectly || runningAsCompiledBunExecutable) {
  main().catch((error) => {
    console.error("[audio-studio] Fatal error:", error);
    process.exitCode = 1;
  });
}
