import assert from "node:assert/strict";
import http from "node:http";
import { createEmbeddingProvider } from "@myknow/db";

const expectedKey = "server-only-test-key";
let received = null;
let serverError = null;
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    try {
      received = { method: request.method, url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) };
      const vector = Array.from({ length: 8 }, (_, index) => (index + 1) / 8);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "test-model", data: [{ embedding: vector }] }));
    } catch (caught) {
      serverError = caught;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "test server assertion failed" } }));
    }
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  const provider = createEmbeddingProvider({ embeddingProvider: "openai-compatible", embeddingModel: "test-model", embeddingDimensions: 8, embeddingApiBaseUrl: `http://127.0.0.1:${address.port}/v1`, embeddingApiKey: expectedKey });
  const result = await provider.embedText("provider contract");
  assert.equal(serverError, null);
  assert.deepEqual(received, { method: "POST", url: "/v1/embeddings", authorization: `Bearer ${expectedKey}`, body: { model: "test-model", input: "provider contract", dimensions: 8 } });
  assert.equal(result.provider, "openai-compatible");
  assert.equal(result.dimensions, 8);
  assert.equal(result.requestedDimensions, 8);
  assert.equal(result.vector.length, 8);
  console.log(JSON.stringify({ status: "passed", provider: result.provider, endpointPath: received.url, dimensions: result.dimensions, authorizationSent: Boolean(received.authorization) }));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
