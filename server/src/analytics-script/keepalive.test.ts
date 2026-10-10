import { describe, expect, it } from "vitest";
import { reserveKeepalive } from "./keepalive.js";

describe("keepalive body reservations", () => {
  it("shares the 64KiB outstanding UTF-8 budget and releases each reservation once", () => {
    const release = reserveKeepalive("界".repeat(16 * 1024));
    expect(release).not.toBeNull();
    const remainder = reserveKeepalive("x".repeat(16 * 1024));
    expect(remainder).not.toBeNull();
    expect(reserveKeepalive("x")).toBeNull();
    release!();
    release!();
    expect(reserveKeepalive("x".repeat(64 * 1024))).toBeNull();
    remainder!();
    const full = reserveKeepalive("x".repeat(64 * 1024));
    expect(full).not.toBeNull();
    full!();
    expect(reserveKeepalive("x".repeat(64 * 1024 + 1))).toBeNull();
  });
});
