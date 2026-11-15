// The part of the Workers runtime's sockets API that post-over-tls.ts uses.
declare module 'cloudflare:sockets' {
  interface SocketAddress {
    hostname: string;
    port: number;
  }

  interface SocketOptions {
    secureTransport?: 'off' | 'on' | 'starttls';
  }

  interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    close(): Promise<void>;
  }

  export function connect(address: SocketAddress, options?: SocketOptions): Socket;
}
