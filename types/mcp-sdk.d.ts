// The MCP SDK's typings name the DOM's global HeadersInit. This project has no
// DOM lib, and Bun's types only declare it as Bun.HeadersInit, so alias it.
declare global {
  type HeadersInit = ConstructorParameters<typeof Headers>[0];
}

export {};
