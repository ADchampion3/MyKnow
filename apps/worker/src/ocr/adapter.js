import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const abortError = () => Object.assign(new Error("OCR processing was cancelled"), { code: "TASK_CANCELLED" });
const throwIfAborted = (signal) => { if (signal?.aborted) throw abortError(); };
const retryable = (caught) => !caught?.code || ["TRANSIENT_ERROR", "OCR_PROVIDER_UNAVAILABLE", "ETIMEDOUT", "ECONNRESET"].includes(caught.code);
const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  throwIfAborted(signal);
  const onAbort = () => { clearTimeout(timer); reject(abortError()); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
});
const withRetries = async (operation, signal, attempts = 3) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); }
    catch (caught) {
      lastError = caught;
      if (attempt === attempts || !retryable(caught)) throw caught;
      await delay(attempt * 50, signal);
    }
  }
  throw lastError;
};

const runPythonJson = (python, args, signal) => new Promise((resolve, reject) => {
  throwIfAborted(signal);
  const child = spawn(python, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  const errors = [];
  let settled = false;
  const finish = (callback, value) => { if (settled) return; settled = true; callback(value); };
  const onAbort = () => { child.kill(); finish(reject, abortError()); };
  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  child.on("error", (caught) => finish(reject, Object.assign(new Error("local OCR runtime is unavailable"), { code: "OCR_PROVIDER_UNAVAILABLE", cause: caught })));
  child.on("close", (code) => {
    signal?.removeEventListener("abort", onAbort);
    if (settled) return;
    const text = Buffer.concat(output).toString("utf8");
    if (code !== 0) return finish(reject, Object.assign(new Error(text || Buffer.concat(errors).toString("utf8") || "local OCR failed"), { code: code === 2 ? "OCR_PROVIDER_UNAVAILABLE" : "OCR_FAILED" }));
    try { finish(resolve, JSON.parse(text)); }
    catch (caught) { finish(reject, Object.assign(new Error("local OCR returned invalid output"), { code: "OCR_RESULT_INVALID", cause: caught })); }
  });
});

// JavaScript has no runtime interface keyword in this project. This abstract class is the OCR Provider SPI contract.
export class OcrProviderAdapter {
  constructor({ provider, name, version, modelName = null, modelVersion = null, capabilities = {} } = {}) {
    if (new.target === OcrProviderAdapter) throw new TypeError("OcrProviderAdapter is an interface and cannot be instantiated");
    if (!provider || !name || !version) throw Object.assign(new Error("OCR adapter identity is required"), { code: "OCR_PROVIDER_INVALID" });
    this.provider = provider;
    this.name = name;
    this.version = version;
    this.modelName = modelName;
    this.modelVersion = modelVersion;
    this.capabilities = Object.freeze({ ...capabilities });
  }

  descriptor() {
    return { provider: this.provider, adapterName: this.name, adapterVersion: this.version, modelName: this.modelName, modelVersion: this.modelVersion, capabilities: this.capabilities };
  }

  async process() {
    throw Object.assign(new Error(`${this.constructor.name} must implement process(request)`), { code: "OCR_PROVIDER_UNAVAILABLE" });
  }
}

export class OcrProviderRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    if (!(adapter instanceof OcrProviderAdapter)) throw Object.assign(new Error("OCR Provider must extend OcrProviderAdapter"), { code: "OCR_PROVIDER_INVALID" });
    if (this.adapters.has(adapter.provider)) throw Object.assign(new Error(`OCR Provider is already registered: ${adapter.provider}`), { code: "OCR_PROVIDER_INVALID" });
    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  resolve(provider) { return this.adapters.get(provider) || null; }
  list() { return [...this.adapters.values()]; }
}

export const renderPdfPages = async ({ sourcePath, python = "python", signal, outputDir = null, scale = 1.5 }) => {
  throwIfAborted(signal);
  const temporary = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), "myknow-pdf-pages-"));
  try {
    const result = await runPythonJson(python, [path.resolve("scripts", "pdf-render.py"), sourcePath, temporary, String(scale)], signal);
    return { pages: result.pages || [], temporary: !outputDir, cleanup: () => { if (!outputDir) fs.rmSync(temporary, { recursive: true, force: true }); } };
  } catch (caught) {
    if (!outputDir) fs.rmSync(temporary, { recursive: true, force: true });
    throw caught;
  }
};

export class LocalOcrProviderAdapter extends OcrProviderAdapter {
  constructor({ config = {}, recognizePage = null } = {}) {
    super({ provider: "local", name: "ocr-local", version: "local-1", modelName: "tesseract", modelVersion: "runtime", capabilities: { text: true, table: true, formula: true } });
    this.config = config;
    this.recognizePage = recognizePage;
  }

  async process(request) {
    throwIfAborted(request.signal);
    if (this.recognizePage) {
      const rendered = await renderPdfPages({ sourcePath: request.sourcePath, python: this.config.pdfPythonPath || "python", signal: request.signal, scale: request.limits?.renderScale || 1.5 });
      try {
        if (request.limits?.maxPages && rendered.pages.length > request.limits.maxPages) throw Object.assign(new Error("OCR page limit exceeded"), { code: "OCR_LIMIT_EXCEEDED" });
        const pages = [];
        for (const page of rendered.pages) {
          throwIfAborted(request.signal);
          const recognized = await withRetries(() => this.recognizePage({ ...request, pageNumber: page.pageNumber, imagePath: page.path, mimeType: "image/png" }), request.signal);
          pages.push({ pageNumber: page.pageNumber, status: "succeeded", ...(recognized || {}) });
          request.onPageProgress?.(page.pageNumber, rendered.pages.length);
        }
        return { pages, capabilities: this.capabilities, metadata: { ...this.descriptor(), requestId: crypto.randomUUID() } };
      } finally { rendered.cleanup(); }
    }
    const result = await runPythonJson(this.config.pdfPythonPath || "python", [path.resolve("scripts", "pdf-ocr.py"), request.sourcePath, JSON.stringify({ capabilities: request.capabilities, maxPages: request.limits?.maxPages || null })], request.signal);
    for (const [index, page] of (result.pages || []).entries()) request.onPageProgress?.(page.pageNumber || index + 1, result.pages.length);
    return { ...result, metadata: { ...this.descriptor(), requestId: crypto.randomUUID(), ...(result.metadata || {}) } };
  }
}

const defaultCloudRecognize = async ({ config, pageImages, request }) => {
  if (!config.modelApiBaseUrl) throw Object.assign(new Error("cloud OCR provider is not configured"), { code: "OCR_PROVIDER_UNAVAILABLE" });
  const form = new FormData();
  form.set("capabilities", JSON.stringify(request.capabilities));
  for (const page of pageImages) form.append("pages", new Blob([fs.readFileSync(page.path)], { type: "image/png" }), `page-${page.pageNumber}.png`);
  const headers = config.modelApiKey ? { authorization: `Bearer ${config.modelApiKey}` } : {};
  const response = await fetch(config.modelApiBaseUrl, { method: "POST", headers, body: form, signal: request.signal });
  if (!response.ok) throw Object.assign(new Error(`cloud OCR returned HTTP ${response.status}`), { code: response.status >= 500 ? "TRANSIENT_ERROR" : "OCR_FAILED" });
  return response.json();
};

export class CloudOcrProviderAdapter extends OcrProviderAdapter {
  constructor({ config = {}, renderPages = renderPdfPages, recognize = defaultCloudRecognize } = {}) {
    super({ provider: "cloud", name: "ocr-cloud", version: "cloud-1", modelName: "configured", modelVersion: "configured", capabilities: { text: true, table: true, formula: true } });
    this.config = config;
    this.renderPages = renderPages;
    this.recognize = recognize;
  }

  async process(request) {
    throwIfAborted(request.signal);
    const rendered = await this.renderPages({ sourcePath: request.sourcePath, python: this.config.pdfPythonPath || "python", signal: request.signal, scale: request.limits?.renderScale || 1.5 });
    try {
      if (request.limits?.maxPages && rendered.pages.length > request.limits.maxPages) throw Object.assign(new Error("OCR page limit exceeded"), { code: "OCR_LIMIT_EXCEEDED" });
      const pageImages = rendered.pages.map((page) => ({ pageNumber: page.pageNumber, path: page.path, mimeType: "image/png" }));
      // ponytail: the cloud seam sends one rendered image per page and keeps the Provider protocol narrow; a Provider SDK can replace this callback later.
      const { sourcePath: _sourcePath, ...providerRequest } = request;
      const result = await withRetries(() => this.recognize({ config: this.config, request: providerRequest, pageImages }), request.signal);
      for (const [index, page] of (result?.pages || []).entries()) request.onPageProgress?.(page.pageNumber || index + 1, result.pages.length);
      return { ...result, metadata: { ...this.descriptor(), requestId: result?.requestId || crypto.randomUUID(), ...(result?.metadata || {}) } };
    } finally { rendered.cleanup?.(); }
  }
}

const PADDLE_OCR_DEFAULT_JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const PADDLE_OCR_DEFAULT_MODEL = "PaddleOCR-VL-1.6";
const PADDLE_OCR_DEFAULT_OPTIONAL_PAYLOAD = Object.freeze({
  useDocOrientationClassify: false,
  useDocUnwarping: false,
  useChartRecognition: false
});

const providerError = (message, code, metadata = {}) => Object.assign(new Error(message), { code, metadata });

class AsyncSemaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit <= 0) throw providerError("OCR concurrency must be a positive integer", "OCR_PROVIDER_INVALID");
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  acquire(signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const queued = { signal, granted: false, onAbort: null, grant: null };
      const remove = () => {
        const index = this.queue.indexOf(queued);
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener("abort", queued.onAbort);
      };
      queued.onAbort = () => {
        if (queued.granted) return;
        remove();
        reject(abortError());
      };
      queued.grant = () => {
        if (queued.granted) return;
        queued.granted = true;
        remove();
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release();
        });
      };
      if (this.active < this.limit) queued.grant();
      else {
        signal?.addEventListener("abort", queued.onAbort, { once: true });
        if (signal?.aborted) return queued.onAbort();
        this.queue.push(queued);
      }
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length) {
      const queued = this.queue.shift();
      if (queued.signal?.aborted) {
        queued.onAbort();
        continue;
      }
      queued.grant();
      break;
    }
  }

  async run(operation, signal) {
    const release = await this.acquire(signal);
    try { return await operation(); } finally { release(); }
  }
}

const paddleJsonlPages = (text) => {
  const pages = [];
  const lines = String(text || "").split(/\r?\n/u);
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    let envelope;
    try { envelope = JSON.parse(line); }
    catch (caught) { throw providerError(`PaddleOCR returned invalid JSONL at line ${lineIndex + 1}`, "OCR_RESULT_INVALID", { line: lineIndex + 1, cause: caught }); }
    const layouts = envelope?.result?.layoutParsingResults;
    if (!Array.isArray(layouts)) throw providerError(`PaddleOCR result is missing layoutParsingResults at line ${lineIndex + 1}`, "OCR_RESULT_INVALID", { line: lineIndex + 1 });
    for (const [layoutIndex, layout] of layouts.entries()) {
      const markdown = typeof layout?.markdown?.text === "string" ? layout.markdown.text : typeof layout?.markdown === "string" ? layout.markdown : "";
      if (!markdown.trim()) throw providerError(`PaddleOCR returned an empty page at line ${lineIndex + 1}`, "OCR_RESULT_INVALID", { line: lineIndex + 1, layout: layoutIndex + 1 });
      pages.push({
        pageNumber: pages.length + 1,
        status: "succeeded",
        blocks: [{ kind: "text", order: 0, text: markdown }],
        warnings: Array.isArray(layout?.warnings) ? layout.warnings.map((warning) => String(warning)).filter(Boolean) : []
      });
    }
  }
  if (!pages.length) throw providerError("PaddleOCR returned no layout pages", "OCR_RESULT_EMPTY");
  return pages;
};

export class PaddleOcrProviderAdapter extends OcrProviderAdapter {
  constructor({ config = {}, fetchImpl = globalThis.fetch, sleep = delay, maxConcurrency = config.paddleOcrMaxConcurrency || 1, pollIntervalMs = config.paddleOcrPollIntervalMs || 5_000, jobUrl = config.paddleOcrJobUrl || PADDLE_OCR_DEFAULT_JOB_URL, token = config.paddleOcrToken || "", model = config.paddleOcrModel || PADDLE_OCR_DEFAULT_MODEL, optionalPayload = config.paddleOcrOptionalPayload || PADDLE_OCR_DEFAULT_OPTIONAL_PAYLOAD } = {}) {
    super({ provider: "paddleocr", name: "ocr-paddleocr", version: "paddleocr-1", modelName: model, modelVersion: "1.6", capabilities: { text: true, table: true, formula: true } });
    if (typeof fetchImpl !== "function") throw providerError("PaddleOCR requires a fetch implementation", "OCR_PROVIDER_INVALID");
    if (typeof sleep !== "function") throw providerError("PaddleOCR requires a sleep implementation", "OCR_PROVIDER_INVALID");
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) throw providerError("PaddleOCR poll interval must be a positive integer", "OCR_PROVIDER_INVALID");
    let parsedJobUrl;
    try { parsedJobUrl = new URL(jobUrl); } catch (caught) { throw providerError("PaddleOCR job URL is invalid", "OCR_PROVIDER_INVALID", { cause: caught }); }
    if (!["http:", "https:"].includes(parsedJobUrl.protocol)) throw providerError("PaddleOCR job URL must use HTTP or HTTPS", "OCR_PROVIDER_INVALID");
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.jobUrl = String(jobUrl).replace(/\/+$/u, "");
    this.token = String(token).trim();
    this.model = model;
    this.optionalPayload = Object.freeze({ ...PADDLE_OCR_DEFAULT_OPTIONAL_PAYLOAD, ...(optionalPayload || {}) });
    this.pollIntervalMs = pollIntervalMs;
    this.limiter = new AsyncSemaphore(maxConcurrency);
  }

  authHeaders() {
    if (!this.token) throw providerError("PaddleOCR token is not configured", "OCR_PROVIDER_CONFIG_INVALID");
    return { authorization: `Bearer ${this.token}` };
  }

  async responseText(response, signal) {
    throwIfAborted(signal);
    const body = await response.text();
    if (!response.ok) {
      const status = Number(response.status) || 0;
      let payload = null;
      let providerMessage = "";
      try {
        payload = JSON.parse(body);
        providerMessage = payload?.errorMsg || payload?.message || payload?.error?.message || "";
      } catch {}
      const redactedBody = String(body || "").replace(/((?:authorization|api[_-]?key|secret|token)\s*[:=]\s*["']?)[^,\s"']+/giu, "$1[redacted]");
      const detail = String(providerMessage || redactedBody).replace(/\s+/gu, " ").trim().slice(0, 500);
      const queueFull = Number(payload?.code) === 10010 || /queue.*full|队列已满/iu.test(detail);
      const code = status === 401 || status === 403 ? "OCR_PROVIDER_AUTH_FAILED" : (queueFull || status === 408 || status === 425 || status === 429 || status >= 500 ? "TRANSIENT_ERROR" : "OCR_FAILED");
      throw providerError(`PaddleOCR request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`, code, { status, providerMessage: detail || undefined });
    }
    return body;
  }

  async request(url, options, signal, parseJson = true) {
    throwIfAborted(signal);
    let response;
    try { response = await this.fetchImpl(url, { ...options, signal }); }
    catch (caught) {
      if (signal?.aborted) throw abortError();
      throw providerError("PaddleOCR network request failed", "TRANSIENT_ERROR", { cause: caught });
    }
    const body = await this.responseText(response, signal);
    if (!parseJson) return body;
    try { return JSON.parse(body); }
    catch (caught) { throw providerError("PaddleOCR returned invalid JSON", "OCR_RESULT_INVALID", { cause: caught }); }
  }

  async submitJob(request) {
    const headers = this.authHeaders();
    const sourceUrl = request.sourceUrl || request.fileUrl;
    if (sourceUrl) {
      let parsedUrl;
      try { parsedUrl = new URL(sourceUrl); } catch (caught) { throw providerError("PaddleOCR source URL is invalid", "OCR_PROVIDER_INVALID", { cause: caught }); }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw providerError("PaddleOCR source URL must use HTTP or HTTPS", "OCR_PROVIDER_INVALID");
      return this.request(this.jobUrl, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ fileUrl: sourceUrl, model: this.model, optionalPayload: this.optionalPayload }) }, request.signal);
    }
    if (!request.sourcePath) throw providerError("PaddleOCR source path is required", "OCR_PROVIDER_INVALID");
    let bytes;
    try { bytes = await fs.promises.readFile(request.sourcePath); }
    catch (caught) { throw providerError("PaddleOCR source file is unavailable", "SOURCE_INTEGRITY_FAILED", { cause: caught }); }
    const form = new FormData();
    form.set("model", this.model);
    form.set("optionalPayload", JSON.stringify(this.optionalPayload));
    form.set("file", new Blob([bytes], { type: request.source?.mimeType || "application/pdf" }), request.source?.filename || path.basename(request.sourcePath));
    return this.request(this.jobUrl, { method: "POST", headers, body: form }, request.signal);
  }

  async pollJob(jobId, request) {
    const signal = request.signal;
    const intervalMs = Number(request.limits?.paddlePollIntervalMs || this.pollIntervalMs);
    const timeoutMs = Number(request.limits?.timeoutMs || 120_000);
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
    const statusUrl = `${this.jobUrl}/${encodeURIComponent(jobId)}`;
    let reportedPages = 0;
    while (true) {
      throwIfAborted(signal);
      const payload = await withRetries(() => this.request(statusUrl, { method: "GET", headers: this.authHeaders() }, signal), signal);
      const data = payload?.data;
      const state = data?.state;
      if (state === "done") {
        const jsonUrl = data?.resultUrl?.jsonUrl;
        if (typeof jsonUrl !== "string" || !jsonUrl) throw providerError("PaddleOCR completed without a JSON result URL", "OCR_RESULT_INVALID");
        return jsonUrl;
      }
      if (state === "failed") throw providerError(`PaddleOCR job failed${data?.errorMsg ? `: ${String(data.errorMsg).slice(0, 500)}` : ""}`, "OCR_FAILED");
      if (state !== "pending" && state !== "running") throw providerError("PaddleOCR returned an unknown job state", "OCR_RESULT_INVALID", { state });
      const progress = data?.extractProgress || {};
      const totalPages = Number(progress.totalPages);
      const extractedPages = Number(progress.extractedPages);
      if (Number.isInteger(totalPages) && totalPages > 0 && Number.isInteger(extractedPages) && extractedPages > reportedPages) {
        reportedPages = Math.min(totalPages, extractedPages);
        request.onPageProgress?.(reportedPages, totalPages);
      }
      if (deadline && Date.now() >= deadline) throw providerError("PaddleOCR polling timed out", "PROCESSING_TIMEOUT", { timeoutMs });
      const remaining = deadline ? Math.max(1, deadline - Date.now()) : intervalMs;
      await this.sleep(Math.min(Math.max(1, intervalMs), remaining), signal);
    }
  }

  async process(request) {
    return this.limiter.run(async () => {
      throwIfAborted(request.signal);
      const started = Date.now();
      const submission = await withRetries(() => this.submitJob(request), request.signal);
      const jobId = submission?.data?.jobId;
      if (typeof jobId !== "string" || !jobId) throw providerError("PaddleOCR submission did not return a job ID", "OCR_RESULT_INVALID");
      const jsonUrl = await this.pollJob(jobId, request);
      let parsedUrl;
      try { parsedUrl = new URL(jsonUrl); } catch (caught) { throw providerError("PaddleOCR result URL is invalid", "OCR_RESULT_INVALID", { cause: caught }); }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw providerError("PaddleOCR result URL must use HTTP or HTTPS", "OCR_RESULT_INVALID");
      const jsonl = await withRetries(() => this.request(parsedUrl.toString(), { method: "GET" }, request.signal, false), request.signal);
      const pages = paddleJsonlPages(jsonl);
      if (request.limits?.maxPages && pages.length > request.limits.maxPages) throw providerError("OCR page limit exceeded", "OCR_LIMIT_EXCEEDED", { maxPages: request.limits.maxPages, pageCount: pages.length });
      for (const page of pages) request.onPageProgress?.(page.pageNumber, pages.length);
      return { pages, capabilities: this.capabilities, metadata: { ...this.descriptor(), requestId: jobId, durationMs: Date.now() - started } };
    }, request.signal);
  }
}

export class MockOcrProviderAdapter extends OcrProviderAdapter {
  constructor({ provider = "local", process, name = `ocr-${provider}-mock`, version = "mock-1", modelName = "mock", modelVersion = "1", capabilities = { text: true, table: true, formula: true }, ...metadata } = {}) {
    super({ provider, name, version, modelName, modelVersion, capabilities });
    if (typeof process !== "function") throw Object.assign(new Error("Mock OCR Provider requires a process implementation"), { code: "OCR_PROVIDER_INVALID" });
    this.handler = process;
    this.extraMetadata = metadata;
  }

  async process(request) {
    throwIfAborted(request.signal);
    const result = await this.handler(request);
    return { ...result, metadata: { ...this.descriptor(), requestId: crypto.randomUUID(), ...this.extraMetadata, ...(result?.metadata || {}) } };
  }
}

export class DefaultOcrProviderRegistry extends OcrProviderRegistry {
  constructor(config = {}) {
    super([new LocalOcrProviderAdapter({ config }), new CloudOcrProviderAdapter({ config }), new PaddleOcrProviderAdapter({ config })]);
  }
}
