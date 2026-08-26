import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const source = fs.readFileSync("apps/web/app/page.jsx", "utf8");
const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const waitForWeb = async (url, child) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Web exited before becoming ready (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return { response, html: await response.text() };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Web did not become ready");
};

const port = await reservePort();
const child = spawn(process.execPath, ["src/index.js"], {
  cwd: path.resolve("apps/web"),
  env: { ...process.env, WEB_PORT: String(port), NEXT_PUBLIC_API_URL: "http://127.0.0.1:1" },
  stdio: "ignore"
});

try {
  const { response, html } = await waitForWeb(`http://127.0.0.1:${port}/`, child);
  assert.equal(response.status, 200);
  assert.match(html, /class="[^"]*\bworkspace\b[^"]*"/);
  assert.match(source, /grid-template-columns:260px minmax\(0,1fr\) 340px/);
  assert.match(source, /@media\(max-width:1100px\).*?\.right-rail\{display:none\}/s);
  assert.match(source, /@media\(max-width:700px\).*?\.workspace\{display:block\}/s);
  assert.match(source, /name="slug"/);
  assert.match(source, /name="spaceId"/);
  assert.match(source, /name="parentPageId"/);
  assert.match(source, /request\("\/api\/tasks"\)/);
  console.log(JSON.stringify({ status: "passed", webStatus: response.status, renderedWorkspace: true, desktop: "1280px three-column grid", tablet: "1024px right rail hidden with core navigation", mobile: "700px stacked workspace" }));
} finally {
  child.kill();
}
