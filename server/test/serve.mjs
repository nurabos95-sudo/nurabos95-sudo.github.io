// Lokaler Test-Server: der Worker mit einer SQLite-Datenbank im Speicher, ohne Cloudflare.
//   node --experimental-sqlite server/test/serve.mjs [Port]
// Nur für Tests: POST /__time {"offset": ms} verschiebt die Uhr (z. B. für den Wochenwechsel), POST /__verify {"on": false} schaltet die Ergebnis-Prüfung ab.
import http from "node:http";
import { D1 } from "./d1shim.mjs";
import { handle } from "../src/worker.js";
import { setBlooms } from "../src/verify.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const env = { DB: new D1(join(here, "..", "schema.sql")) };
setBlooms(Object.fromEntries(["de", "en", "es", "fr", "pt"].map((l) => [l, readFileSync(join(here, "..", "dict", l + ".bin"))])));
let offset = 0;
const port = Number(process.argv[2] || 8787);
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.url === "/__flags") { const r = await env.DB.prepare("SELECT kind, reason FROM flags").all(); res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(r.results)); }
  if (req.url === "/__verify") { env.VERIFY = JSON.parse(body.toString() || "{}").on === false ? "off" : undefined; res.writeHead(200, { "access-control-allow-origin": "*" }); return res.end("{}"); }
  if (req.url === "/__time") { offset = JSON.parse(body.toString() || "{}").offset || 0; res.writeHead(200, { "access-control-allow-origin": "*" }); return res.end("{}"); }
  const r = await handle(new Request("http://localhost:" + port + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env, Date.now() + offset);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log("Wortpoker-Testserver auf Port " + port));
