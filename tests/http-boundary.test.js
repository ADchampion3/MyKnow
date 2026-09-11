import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createApiRouteHandler, createRequestHandler } from "../apps/api/src/app.js";
import { createHttpTools } from "../apps/api/src/http.js";
import { createDatabase, migrate } from "@myknow/db";

const config = { webPort: 3000, resourceMaxBytes: 4 };

describe("HTTP boundary", () => {
  it("parses JSON through the Fetch Request and validates the object shape", async () => {
    const http = createHttpTools({ config });
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" })
    });

    await expect(http.readBody(request)).resolves.toEqual({ name: "demo" });
    await expect(http.readBody(new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["not an object"])
    }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("parses multipart files through Request.formData", async () => {
    const http = createHttpTools({ config });
    const form = new FormData();
    form.set("name", "demo.txt");
    form.set("file", new File(["hello"], "demo.txt", { type: "text/plain" }));

    const body = await http.readBody(new Request("http://localhost/api/resources", { method: "POST", body: form }), http.bodySchemaFor({ pathname: "/api/resources", method: "POST" }));
    expect(body).toMatchObject({ name: "demo.txt", file: { filename: "demo.txt", mimeType: "text/plain" } });
    expect(body.file.bytes).toEqual(Buffer.from("hello"));
  });

  it("keeps the request-size ceiling while using the Web stream adapter", async () => {
    const http = createHttpTools({ config });
    const nodeRequest = Readable.from([Buffer.alloc(600_000)]);
    Object.assign(nodeRequest, { method: "POST", url: "/api/test", headers: { "content-type": "application/json" } });

    await expect(http.readBody(http.requestFromNode(nodeRequest))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "request body is too large" });
    await expect(http.readBody(new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "600000" },
      body: "{}"
    }))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "request body is too large" });
  });

  it("returns the stable envelope and redacts error details", async () => {
    const http = createHttpTools({ config });
    const success = await http.ok(http.createReply("http://localhost:3000"), 200, { value: true }, "request-1").json();
    expect(success).toEqual({ data: { value: true }, error: null, requestId: "request-1" });

    const reply = http.createReply("http://localhost:3000");
    await http.fail(reply, 400, { code: "VALIDATION_ERROR", message: "token=Bearer abcdefghijkl" }, "request-2").json();
    expect(reply.payload).toEqual({ data: null, error: { code: "VALIDATION_ERROR", message: "token=[REDACTED]" }, requestId: "request-2" });
  });

  it("exposes a Response-returning route handler for App Router-style mounting", async () => {
    const database = createDatabase(":memory:");
    migrate(database.sqlite);
    try {
      const handle = createApiRouteHandler({ config: { ...config, resourceStorageDir: "." }, sqlite: database.sqlite, db: database.db });
      const response = await handle(new Request("http://localhost/health"));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe(body.requestId);
      expect(body.data).toEqual({ status: "ok", service: "api" });
    } finally {
      database.sqlite.close();
    }
  });

  it("keeps the standalone Nest adapter limited to Node/Web Response conversion", async () => {
    const database = createDatabase(":memory:");
    migrate(database.sqlite);
    try {
      const handle = createRequestHandler({ config: { ...config, resourceStorageDir: "." }, sqlite: database.sqlite, db: database.db });
      const nodeRequest = Readable.from([Buffer.from(JSON.stringify({ name: "adapter" }))]);
      Object.assign(nodeRequest, { method: "POST", url: "/api/knowledge-bases", headers: { "content-type": "application/json" } });
      const nodeResponse = {
        statusCode: null,
        headers: null,
        body: null,
        status(value) { this.statusCode = value; return this; },
        set(value) { this.headers = value; return this; },
        send(value) { this.body = value; return this; }
      };

      await handle(nodeRequest, nodeResponse);
      expect(nodeResponse.statusCode).toBe(201);
      expect(JSON.parse(nodeResponse.body.toString()).data.name).toBe("adapter");
      expect(nodeResponse.headers["x-request-id"]).toBeTruthy();
    } finally {
      database.sqlite.close();
    }
  });
});
