import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNovncTarget, safeProxyHeaders, watchScreenAuthorization } from "./screen-proxy.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("screen proxy", () => {
  it("rejects legacy URLs without contacting the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await resolveNovncTarget("/novnc/old/view/token/embed.html", "secret", "http://api.example"),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks each request and fails closed on revocation or API failure", async () => {
    const target = {
      protocol: "http:",
      hostname: "127.0.0.1",
      port: 49152,
      path: "/websockify",
      interactive: false,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(target))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    const resolve = () =>
      resolveNovncTarget("/novnc/session/view/token/websockify", "secret", "http://api.example");
    expect(await resolve()).toEqual(target);
    expect(await resolve()).toBeNull();
    expect(await resolve()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer secret" },
    });
  });
  it("fails closed for a malformed authority response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ hostname: "screen.example", port: "443" })),
    );
    expect(
      await resolveNovncTarget(
        "/novnc/session/view/token/vnc.html",
        "secret",
        "http://api.example",
      ),
    ).toBeNull();
  });

  it("closes an active stream on revocation and stops checking closed streams", async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const revoke = vi.fn();
    watchScreenAuthorization(check, revoke);
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledTimes(2);
    const stop = watchScreenAuthorization(check, revoke);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("closes a stream when authorization fails unexpectedly", async () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    watchScreenAuthorization(async () => {
      throw new Error("unavailable");
    }, revoke);
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it("forwards only the WebSocket handshake to the computer", () => {
    const handshake = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "key",
      "sec-websocket-version": "13",
      "sec-websocket-protocol": "binary",
    };
    expect(
      safeProxyHeaders({
        ...handshake,
        ":authority": "localhost:5173",
        host: "app.example",
        cookie: "session=fake",
        authorization: "Bearer fake",
        "proxy-authorization": "Basic fake",
        "cf-access-client-id": "fake-id",
        "cf-access-client-secret": "fake-secret",
        "cf-access-jwt-assertion": "fake-jwt",
        "x-forwarded-access-token": "fake-token",
        "x-auth-request-access-token": "fake-token",
        "x-forwarded-user": "fake-user",
        "x-forwarded-email": "user@example.com",
        "x-api-key": "fake-key",
      }),
    ).toEqual(handshake);
  });
});
