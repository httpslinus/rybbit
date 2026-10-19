import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("dashboard API origin", () => {
  it.each(["https://data.nullzwei.com", "https://data.linus.systems"])(
    "keeps login requests on %s when built for same-origin access",
    async origin => {
      vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "");
      vi.stubEnv("BASE_URL", "");
      vi.stubGlobal("window", { location: new URL(`${origin}/login`) });
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Invalid email or password" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      const { BACKEND_URL } = await import("./const");
      const { authClient } = await import("./auth");
      await authClient.signIn.email({ email: "test@example.invalid", password: "invalid" });

      expect(BACKEND_URL).toBe("/api");
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(`${origin}/api/auth/sign-in/email`);
      expect(options.credentials).toBe("include");
      expect(options.method).toBe("POST");
    }
  );

  it("uses relative API requests when the backend URL is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", undefined);
    expect((await import("./const")).BACKEND_URL).toBe("/api");
  });

  it("preserves a separately configured API origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "http://localhost:3001");
    expect((await import("./const")).BACKEND_URL).toBe("http://localhost:3001/api");
  });
});
