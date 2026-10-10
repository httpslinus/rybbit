import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

export const baseUrl = process.env.HEATMAP_QA_URL || "http://localhost:18033";
const cacheDirectory = new URL(".cache/", import.meta.url);
const stateFile = new URL("state.json", cacheDirectory);

export async function localAccount() {
  await mkdir(cacheDirectory, { recursive: true });
  let state;
  try { state = JSON.parse(await readFile(stateFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const cookieJar = new Map();
  const call = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Origin: baseUrl,
        Cookie: [...cookieJar].map(([key, value]) => `${key}=${value}`).join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const index = pair.indexOf("=");
      cookieJar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const result = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  if (state) {
    await call("/auth/sign-in/email", { email: state.email, password: state.password });
  } else {
    const suffix = randomBytes(8).toString("hex");
    state = { email: `heatmap-qa-${suffix}@example.test`, password: randomBytes(24).toString("base64url") };
    await call("/auth/sign-up/email", { ...state, name: "Heatmap local QA" });
    const organization = await call("/auth/organization/create", { name: "Heatmap local QA", slug: `heatmap-qa-${suffix}` });
    state.organizationId = organization.id;
  }
  await call("/auth/organization/set-active", { organizationId: state.organizationId });
  if (!state.siteId) {
    const site = await call(`/organizations/${state.organizationId}/sites`, {
      domain: "qa.heatmap.test", name: "Heatmap responsive fixture", blockBots: false, saltUserIds: false,
    });
    state.siteId = site.siteId;
  }
  await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  return { siteId: state.siteId, organizationId: state.organizationId, call,
    cookies: [...cookieJar].map(([name, value]) => ({ name, value, url: baseUrl })) };
}

export function responsiveFixture(siteId, { tracking = true, blocked = false } = {}) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;width:100%;height:2000px;font:16px sans-serif;background:#fafafa;color:#141414}
header{position:fixed;top:0;left:0;height:48px;width:100%;background:#222;color:white;z-index:5}
.target{position:absolute;left:40px;top:850px;width:120px;height:40px;border:0;background:#4169e1;color:white}
@media(min-width:700px){.target{left:240px;width:160px}}@media(min-width:1200px){.target{left:620px;width:200px}}
input{position:absolute;top:1600px;left:40px}a{position:absolute;top:120px;left:40px}</style></head><body>
<header>Fixed fixture header</header><a href="/b" id="route">Next route</a>
<button class="target" data-qa="target">Sensitive DOM sentinel</button>
<input value="sensitive-input-sentinel" aria-label="Fixture private input">
<script>document.getElementById('route').onclick=e=>{e.preventDefault();history.pushState({},'', '/b');};</script>
${tracking && !blocked ? `<script src="${baseUrl}/api/script.js" data-site-id="${siteId}" data-debug="true"></script>` : ""}
</body></html>`;
}

export const fixtureOrigin = "https://qa.heatmap.test";
export async function startFixtureServer(siteId) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(responsiveFixture(siteId, { tracking: request.url !== "/blocked" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://qa.heatmap.test:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
export async function interceptFixture(page, siteId, tracking = true, beforeContinue) {
  await page.setRequestInterception(true);
  page.on("request", async request => {
    const url = new URL(request.url());
    if (url.hostname !== "qa.heatmap.test") {
      await beforeContinue?.(request);
      return request.continue();
    }
    const blocked = url.pathname === "/blocked";
    return request.respond({ status: 200, contentType: "text/html", headers: blocked ? {
      "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'",
    } : {}, body: responsiveFixture(siteId, { tracking: tracking && request.frame() === page.mainFrame(), blocked }) });
  });
}
