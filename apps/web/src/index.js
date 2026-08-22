import next from "next";
import http from "node:http";
import { loadConfig } from "@myknow/config";
const config = loadConfig();
const app = next({ dev: true, dir: process.cwd() });
const handle = app.getRequestHandler();
await app.prepare();
http.createServer((req, res) => handle(req, res)).listen(config.webPort, () => console.log(`Next.js Web listening on http://localhost:${config.webPort}`));
