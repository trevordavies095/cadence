// A Tempo that only answers sign-in, for the Sign in with Tempo spec. One athlete:
// lauren / correct horse battery staple. Port from FAKE_TEMPO_PORT.
import http from "node:http";

const port = Number(process.env.FAKE_TEMPO_PORT ?? 5199);

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"healthy"}');
      return;
    }
    if (req.method === "POST" && req.url === "/auth/login") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {
          // fall through to 400
        }
        if (!body.username || !body.password) {
          res.writeHead(400).end();
        } else if (body.username === "lauren" && body.password === "correct horse battery staple") {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ userId: "e2e", username: "lauren" }));
        } else {
          res.writeHead(401).end();
        }
      });
      return;
    }
    res.writeHead(404).end();
  })
  .listen(port, () => console.log(`fake Tempo on ${port}`));
