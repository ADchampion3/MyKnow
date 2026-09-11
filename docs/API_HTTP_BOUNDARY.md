# API HTTP boundary

The API keeps HTTP policy at the edge and leaves wire-format parsing to the
Fetch Web API.

```text
Request
  -> request.json() / request.formData()
  -> Zod shape validation
  -> route and service logic
  -> domain error mapping
  -> Response.json({ data, error, requestId })
```

`createApiRouteHandler()` accepts a Web `Request` and returns a Web
`Response`, so it can be mounted by a Next App Router route handler. The
current standalone API process uses `createRequestHandler()` as a thin
Nest/Express adapter. That adapter is the only place that converts a Node
request/response to and from the Web APIs.

JSON and multipart requests are parsed by `Request.json()` and
`Request.formData()`. Multipart files are normalized to the service boundary
as `{ filename, mimeType, bytes }`; multipart syntax is not parsed in
application code. Zod rejects non-object bodies and validates the upload
shape before the route runs.

`RESOURCE_MAX_BYTES` remains a business rule. The Node-to-Web stream adapter
and `readBody`'s Web-stream guard reject a request once it exceeds the
resource limit plus a small multipart envelope allowance, while the resource
service applies the exact file-byte limit before persisting source material.
Original materials and audit records remain untouched by this boundary
refactor.

All JSON responses use `{ data, error, requestId }`. Known domain/provider
codes are mapped to HTTP status codes; unknown failures become
`INTERNAL_ERROR`. Provider details, API keys, tokens, and database errors are
redacted before a response is returned. `requestId` is included both in the
JSON envelope and in the `x-request-id` response header.

The development setup runs Web and API on different localhost ports, so the
small localhost CORS policy remains. Same-origin deployments do not need a
custom CORS policy. Large-object direct upload through S3, R2, or MinIO is
deferred until an object-storage adapter and an object-key-to-resource
workflow exist; the current bounded upload path intentionally handles only
small files.
