// The MCP SDK's typings name the DOM's global HeadersInit. This project has no
// DOM lib, and Node's types declare Headers but not HeadersInit, so alias it.
declare global {
  type HeadersInit = ConstructorParameters<typeof Headers>[0];
}

export {};
