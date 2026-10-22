// Lokaler Test-Server: der Worker mit einer SQLite-Datenbank im Speicher, ohne Cloudflare.
//   node --experimental-sqlite server/test/serve.mjs [Port]
// Nur für Tests: POST /__time {"offset": ms} verschiebt die Uhr (z. B. für den Wochenwechsel).
import http from "node:http";
import { D1 } from "./d1shim.mjs";
import { handle } from "../src/worker.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const env = { DB: new D1(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql")) };
let offset = 0;
const port = Number(process.argv[2] || 8787);
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.url === "/__time") { offset = JSON.parse(body.toString() || "{}").offset || 0; res.writeHead(200, { "access-control-allow-origin": "*" }); return res.end("{}"); }
  const r = await handle(new Request("http://localhost:" + port + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env, Date.now() + offset);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log("Wortpoker-Testserver auf Port " + port));
