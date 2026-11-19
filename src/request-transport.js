import { Agent, fetch as httpFetch } from "undici";
import { defaults } from "./policy.js";

function agentFor(timing) {
  return new Agent({
    connect: { timeout: timing.connectMs },
    headersTimeout: timing.idleMs,
    bodyTimeout: timing.idleMs,
  });
}
const sharedAgent = agentFor(defaults);

export function timeoutError(message) {
  return Object.assign(Error(message), { name: "TimeoutError" });
}

// One capture and abort signal per upstream attempt, including the non-streaming protocol.
export function requestTransport(c, p, extra, signal) {
  const timing = { ...defaults, ...c.timeout };
  const controller = new AbortController();
  const signals = [controller.signal];
  if (signal) signals.push(signal);
  const combined = AbortSignal.any(signals);
  const total = setTimeout(
    () => controller.abort(timeoutError("请求总时限已到")),
    timing.totalMs,
  );
  let idle;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(timeoutError("读取空闲超时")),
      timing.idleMs,
    );
  };
  const capture = {
    usage: null,
    cost: null,
    currency: null,
    requestId: null,
    partial: "",
    reasoning: "",
    rawUsage: null,
    ...(c.logprobs === true ? { logprobs: { content: [], reasoning: [] } } : {}),
  };
  let apiError;
  let logprobSize = 0;
  function appendLogprobs(target, entries) {
    if (!Array.isArray(entries)) return;
    logprobSize += JSON.stringify(entries).length;
    if (logprobSize > 32_000_000)
      throw Object.assign(Error("Token 概率数据超过本地 32M 字符上限"), { kind: "output" });
    for (const entry of entries) target.push(entry);
  }
  const dispatcher = timing.connectMs === defaults.connectMs && timing.idleMs === defaults.idleMs
    ? sharedAgent : agentFor(timing);
  function inspect(obj, ok = true) {
    if (!obj || typeof obj !== "object") return;
    if (capture.logprobs) {
      if (p === "chat") {
        for (const choice of obj.choices || []) {
          if ((choice.index ?? 0) !== 0) continue;
          appendLogprobs(capture.logprobs.content, choice.logprobs?.content);
          appendLogprobs(capture.logprobs.reasoning, choice.logprobs?.reasoning_content);
        }
      } else if (p === "responses" && obj.type === "response.output_text.delta" && Array.isArray(obj.logprobs)) {
        appendLogprobs(capture.logprobs.content, obj.logprobs);
      } else if (p === "responses" && c.stream === false) {
        for (const item of obj.output ?? [])
          for (const part of item.content ?? []) appendLogprobs(capture.logprobs.content, part.logprobs);
      }
    }
    capture.requestId ||= obj.id || obj.response?.id || obj.message?.id || null;
    const blockReason = obj.promptFeedback?.blockReason;
    if (["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"].includes(blockReason))
      capture.contentFilter = { reason: blockReason };

    const u =
      obj.usage ||
      obj.usageMetadata ||
      obj.response?.usage ||
      obj.message?.usage;
    if (u) {
      capture.rawUsage = { ...(capture.rawUsage || {}), ...u };
      const z = capture.rawUsage;
      capture.usage = {
        inputTokens:
          z.prompt_tokens ?? z.input_tokens ?? z.promptTokenCount ?? 0,
        outputTokens:
          z.completion_tokens ?? z.output_tokens ?? z.candidatesTokenCount ?? 0,
        raw: z,
      };
      if (typeof u.cost === "number" && Number.isFinite(u.cost)) {
        capture.cost = u.cost;
        capture.currency =
          u.currency || (c.provider === "opencode" ? "USD" : "unknown");
      }
    }
    if (ok && obj.error)
      apiError = Object.assign(
        Error(obj.error.message || JSON.stringify(obj.error)),
        { responseBody: JSON.stringify(obj.error), statusCode: obj.error.status_code ?? obj.error.status },
      );
  }
  const wrappedFetch = async (url, init) => {
    const original = JSON.parse(init.body);
    const body = { ...original, ...extra };
    if (c.logprobs === true && p === "chat") {
      body.logprobs = true;
      if (c.topLogprobs !== undefined) body.top_logprobs = c.topLogprobs;
    } else if (c.logprobs === true && p === "responses") {
      body.include = [...new Set([...(body.include || []), "message.output_text.logprobs"])];
      body.top_logprobs = c.topLogprobs ?? 0;
    }
    if (extra.generationConfig)
      body.generationConfig = {
        ...original.generationConfig,
        ...extra.generationConfig,
      };
    touch();
    const response = await httpFetch(url, {
      ...init, body: JSON.stringify(body), signal: combined, dispatcher,
    });
    capture.requestId =
      response.headers.get("x-request-id") ||
      response.headers.get("request-id");
    const retry = response.headers.get("retry-after");
    if (retry) {
      const delay = Number.isFinite(Number(retry))
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now();
      if (Number.isFinite(delay)) capture.retryAfter = Math.max(0, delay);
    }
    if (!response.body) return response;
    if (!response.ok || p === "systemone" || c.stream === false) {
      const maxBytes = response.ok && c.stream === false ? 32_000_000 : 2_000_000;
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        touch();
        bytes += chunk.length;
        if (bytes > maxBytes) {
          if (!response.ok) break; // Preserve the HTTP status and bounded error body.
          throw Object.assign(Error(`JSON 响应超过 ${maxBytes / 1_000_000}MB`), { kind: "output" });
        }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (p !== "systemone") {
        try {
          inspect(JSON.parse(raw), response.ok);
        } catch (error) {
          if (error.kind === "output") throw error;
          /* The SDK reports malformed JSON. */
        }
      }
      return new Response(raw, {
        status: response.status,
        headers: response.headers,
      });
    }
    let buffer = "";
    const decoder = new TextDecoder();
    const bodyStream = response.body.pipeThrough(
      new TransformStream({
        transform(chunk, out) {
          touch();
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 2_000_000) {
            controller.abort(
              Object.assign(Error("响应单事件超过 2MB"), { kind: "output" }),
            );
            throw controller.signal.reason;
          }
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (data && data !== "[DONE]") {
                try {
                  inspect(JSON.parse(data));
                } catch (error) {
                  if (error.kind === "output") throw error;
                  /* SDK validates malformed events. */
                }
              }
            }
          }
          out.enqueue(chunk);
        },
        flush() {
          clearTimeout(idle);
        },
      }),
    );
    return new Response(bodyStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return {
    fetch: wrappedFetch, signal: combined, capture, inspect,
    get apiError() { return apiError; },
    close() {
      clearTimeout(total);
      clearTimeout(idle);
      controller.abort();
      if (dispatcher !== sharedAgent) void dispatcher.close();
    },
  };
}
