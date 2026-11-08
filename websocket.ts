// The `websocket` protocol. Portable, except that browsers cannot send
// handshake headers.

export { WebSocketClient } from "./src/protocols/websocket.js";
export type { WebSocketClientOptions } from "./src/protocols/websocket.js";
export type { WebSocketFactory, WebSocketInit } from "./src/socket.js";
