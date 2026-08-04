# Contributing

Issues and pull requests are welcome.

1. Install Node.js 18 or newer and run `npm ci`.
2. Make focused changes with tests.
3. Run `npm run check` before opening a pull request.
4. Keep MCP tools useful without the UI and preserve the portable MCP Apps bridge.

For native plugin hosting work, propose the security boundary first. Plugins must run out of process, crash independently, and never be loaded by the MCP App iframe.
