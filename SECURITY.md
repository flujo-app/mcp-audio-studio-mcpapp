# Security policy

## Supported versions

The latest tagged release receives security fixes.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not include secrets, private audio, or proprietary plugin binaries in a public issue.

Include the affected version, transport, MCP host, reproduction steps, and impact. Reports involving remote resource loading, path handling, audio decoding, iframe permissions, or future native plugin bridges are especially useful.

## Trust boundaries

- MCP tool input is untrusted and validated with Zod.
- The server owns durable project state; iframe/widget state is not authoritative.
- The MCP App is delivered as a sandboxed, self-contained HTML resource.
- VST3 paths and states are inert metadata in version 0.1.x. No native binary is loaded.
