// Keep the build-time localhost URL reachable during server rendering inside
// the dashboard container as well as from the browser on the host.
const http = require("node:http");

const loopback = http.createServer((request, response) => {
  const upstream = http.request(
    {
      hostname: "backend",
      port: 3001,
      path: request.url,
      method: request.method,
      headers: request.headers,
    },
    upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    }
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("Local API unavailable");
  });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
});

loopback.on("error", error => {
  console.error("Local API loopback could not start:", error.message);
  process.exit(1);
});
loopback.listen(18033, "127.0.0.1", () => {
  require("/app/client/server.js");
});
