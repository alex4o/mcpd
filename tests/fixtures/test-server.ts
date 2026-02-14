// A tiny HTTP server for testing readiness checks.
// Listens on the port passed as argv[2] (or random), responds 200 to GET /.
// Exits cleanly on SIGTERM.

const port = parseInt(process.argv[2] || "0");

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
});

// Print the port so the parent process can read it
console.log(server.port);

process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
