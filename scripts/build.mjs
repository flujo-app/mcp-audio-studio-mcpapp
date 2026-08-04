import { build, context } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const webDirectory = path.join(root, "src", "web");
const distDirectory = path.join(root, "dist");

async function buildStudioHtml() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/web/studio.tsx"],
    bundle: true,
    write: false,
    outdir: "virtual-web",
    platform: "browser",
    format: "iife",
    target: ["es2020"],
    minify: !watch,
    sourcemap: watch ? "inline" : false,
    jsx: "automatic",
    logLevel: "silent",
  });
  const javascript = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
  const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  if (!javascript) throw new Error("The studio UI bundle did not produce JavaScript.");
  const template = await readFile(path.join(webDirectory, "index.html"), "utf8");
  return template
    .replace("</head>", () => `<style>${css}</style></head>`)
    .replace("</body>", () => `<script>${javascript.replaceAll("</script", "<\\/script")}</script></body>`);
}

let latestHtml = "";
const studioHtmlPlugin = {
  name: "studio-html",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^virtual:studio-html$/ }, () => ({ path: "studio-html", namespace: "audio-studio" }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "audio-studio" }, async () => {
      latestHtml = await buildStudioHtml();
      await mkdir(distDirectory, { recursive: true });
      await writeFile(path.join(distDirectory, "studio-ui.html"), latestHtml, "utf8");
      return {
        contents: `export default ${JSON.stringify(latestHtml)};`,
        loader: "js",
        watchDirs: [webDirectory, path.join(root, "src", "shared")],
      };
    });
  },
};

const serverOptions = {
  absWorkingDir: root,
  entryPoints: ["src/server/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node18"],
  minify: false,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __audioStudioCreateRequire } from 'node:module'; const require = __audioStudioCreateRequire(import.meta.url);" },
  plugins: [studioHtmlPlugin],
  logLevel: "info",
};

await rm(distDirectory, { recursive: true, force: true });
await mkdir(distDirectory, { recursive: true });
if (watch) {
  const buildContext = await context(serverOptions);
  await buildContext.watch();
  console.log("Watching server and studio UI sources…");
} else {
  await build(serverOptions);
  console.log(`Built MCP server (${(await readFile(path.join(distDirectory, "index.js"))).length.toLocaleString()} bytes) with inline studio UI (${latestHtml.length.toLocaleString()} bytes).`);
}
