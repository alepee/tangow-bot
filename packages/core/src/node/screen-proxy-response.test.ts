import { describe, expect, it } from "vitest";
import { stripSensitiveHandshakeHeaders } from "./screen-proxy-response.js";

describe("screen socket handshake", () => {
  it("preserves WebSocket negotiation and bytes without accepting origin mutations", () => {
    const handshake = Buffer.from(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake-accept\r\nSet-Cookie: session=attacker\r\nClear-Site-Data: "cookies"\r\n\r\n\u0082\u0001x',
      "latin1",
    );
    expect(stripSensitiveHandshakeHeaders(handshake)?.toString("latin1")).toBe(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake-accept\r\n\r\n\u0082\u0001x",
    );
    expect(stripSensitiveHandshakeHeaders(Buffer.from("HTTP/1.1 101"))).toBeNull();
  });
});
