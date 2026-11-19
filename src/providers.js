import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { Agent, fetch as httpFetch } from "undici";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defaults, normalizeThinking, usesSystemOne, validateConfig } from "./policy.js";
const endpoints = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  mimo: "https://api.xiaomimimo.com/v1",
  bailian: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  opencode: "https://opencode.ai/inference",
};
const agents = new Map();
const credentialSecrets = new Set();
export function refreshCredentials(provider, envPath = ".env") {
  if (!Object.hasOwn(endpoints, provider)) throw Error("未知 provider");
  const name = `${provider.toUpperCase()}_API_KEY`;
  try {
    const value = parseEnv(readFileSync(envPath, "utf8"))[name]?.trim();
    // Explicit recovery adopts a newly supplied key without changing other settings.
    if (value) {
      if (process.env[name]?.trim()) credentialSecrets.add(process.env[name].trim());
      process.env[name] = value;
      credentialSecrets.add(value);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return Boolean(process.env[name]?.trim());
}
export function protocol(c) {
  if (usesSystemOne(c)) return "systemone";
  if (c.protocol) return c.protocol;
  if (c.provider === "openai") return "responses";
  if (c.provider !== "opencode") return "chat";
  if (/^(claude|qwen)/i.test(c.model)) return "anthropic";
  if (/^(gpt|o[134](?:-|$))/i.test(c.model)) return "responses";
  if (/^gemini/i.test(c.model)) return "google";
  return "chat";
}
export function bodyOptions(c, p) {
  const b = { ...c.extraBody };
  const t = normalizeThinking(c.thinking);
  if (t) {
    if (p === "chat") {
      if (c.provider === "openai") {
        if (t.budget !== undefined)
          throw Object.assign(Error("OpenAI 使用 thinking 强度，不支持 thinking.budget"), {
            kind: "parameter",
          });
        b.reasoning_effort = t.enabled ? t.effort || "medium" : "none";
        return b;
      } else if (c.provider === "bailian") {
        b.enable_thinking = t.enabled;
        if (t.budget !== undefined) b.thinking_budget = t.budget;
      } else {
        b.thinking = { type: t.enabled ? "enabled" : "disabled" };
        if (t.budget !== undefined)
          throw Object.assign(
            Error("不支持参数 thinking.budget：此适配器无法可靠映射"),
            { kind: "parameter" },
          );
      }
      if (t.effort !== undefined) b.reasoning_effort = t.effort;
    } else if (p === "anthropic") {
      if (t.enabled && t.effort !== undefined) {
        if (t.budget !== undefined || t.effort === "minimal")
          throw Object.assign(
            Error("Anthropic 强度需使用 low/medium/high/xhigh/max，且不能同时设置 budget"),
            { kind: "parameter" },
          );
        b.thinking = { type: "adaptive" };
        b.output_config = { ...(b.output_config || {}), effort: t.effort };
        return b;
      }
      if (t.enabled && !t.budget)
        throw Object.assign(Error("thinking.budget 为 Anthropic 必填"), {
          kind: "parameter",
        });
      b.thinking = t.enabled
        ? { type: "enabled", budget_tokens: t.budget }
        : { type: "disabled" };
    } else if (p === "responses") {
      if (t.budget !== undefined)
        throw Object.assign(
          Error("不支持参数 thinking.budget：Responses 使用 effort"),
          { kind: "parameter" },
        );
      b.reasoning = { effort: t.enabled ? t.effort || "medium" : "none" };
    } else {
      if (t.enabled && t.effort !== undefined &&
          (t.budget !== undefined || !["minimal", "low", "medium", "high"].includes(t.effort)))
        throw Object.assign(
          Error("Google 强度需使用 minimal/low/medium/high，且不能同时设置 budget"),
          { kind: "parameter" },
        );
      b.generationConfig = {
        ...(b.generationConfig || {}),
        thinkingConfig: {
          ...(t.enabled && t.effort !== undefined
            ? { thinkingLevel: t.effort }
            : { thinkingBudget: t.enabled ? (t.budget ?? -1) : 0 }),
          includeThoughts: t.enabled,
        },
      };
    }
  }
  return b;
}
function timeoutError(message) {
  return Object.assign(new Error(message), { name: "TimeoutError" });
}
function redact(message) {
  let s = String(message);
  const secrets = new Set(credentialSecrets);
  for (const p of Object.keys(endpoints)) {
    const key = process.env[`${p.toUpperCase()}_API_KEY`];
    if (key) secrets.add(key);
  }
  for (const key of secrets) s = s.replaceAll(key, "[REDACTED]");
  return s.slice(0, 12000);
}
export function errorRecord(e) {
  return {
    kind: e.kind,
    code: e.code,
    message: redact(e.message),
    status: e.statusCode || e.status,
    body: e.responseBody ? redact(e.responseBody) : undefined,
  };
}
export async function invoke(c, q, { signal } = {}) {
  const p = protocol(c),
    extra = bodyOptions(c, p);
  if (p === "systemone") {
    validateConfig(c);
    if (typeof q.prompt !== "string" || !q.prompt.trim() || q.messages !== undefined)
      throw Object.assign(Error("systemone 需要使用 query.prompt 提供 state 文本"), { kind: "parameter" });
  }
  if (c.logprobs === true && !["chat", "responses"].includes(p))
    throw Object.assign(Error(`当前 ${p} 协议不支持统一 logprobs`), { kind: "parameter" });
  const key = process.env[`${c.provider.toUpperCase()}_API_KEY`]?.trim();
  if (!key)
    throw Object.assign(Error(`${c.provider.toUpperCase()}_API_KEY 未配置；请补充 .env 后点击恢复或重试`), {
      kind: "auth",
      code: "MISSING_API_KEY",
    });
  credentialSecrets.add(key);
  const base = (
    process.env[`${c.provider.toUpperCase()}_BASE_URL`] || endpoints[c.provider]
  ).replace(/\/$/, "");
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
  let logprobSize = 0;
  function appendLogprobs(target, entries) {
    if (!Array.isArray(entries)) return;
    logprobSize += JSON.stringify(entries).length;
    if (logprobSize > 32_000_000)
      throw Object.assign(Error("Token 概率数据超过本地 32M 字符上限"), { kind: "output" });
    target.push(...entries);
  }
  const aid = JSON.stringify(timing);
  if (!agents.has(aid))
    agents.set(
      aid,
      new Agent({
        connect: { timeout: timing.connectMs },
        headersTimeout: timing.idleMs,
        bodyTimeout: timing.idleMs,
      }),
    );
  function inspect(obj) {
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
    if (obj.error)
      capture.apiError = Object.assign(
        Error(obj.error.message || JSON.stringify(obj.error)),
        { responseBody: JSON.stringify(obj.error) },
      );
  }
  const wrappedFetch = async (url, init) => {
    let body = JSON.parse(init.body);
    body = { ...body, ...extra };
    if (c.logprobs === true && p === "chat") {
      body.logprobs = true;
      if (c.topLogprobs !== undefined) body.top_logprobs = c.topLogprobs;
    } else if (c.logprobs === true && p === "responses") {
      body.include = [...new Set([...(body.include || []), "message.output_text.logprobs"])];
      body.top_logprobs = c.topLogprobs ?? 0;
    }
    if (extra.generationConfig)
      body.generationConfig = {
        ...JSON.parse(init.body).generationConfig,
        ...extra.generationConfig,
      };
    touch();
    let response;
    try {
      response = await httpFetch(url, {
        ...init,
        body: JSON.stringify(body),
        signal: combined,
        dispatcher: agents.get(aid),
      });
    } catch (e) {
      throw combined.aborted ? combined.reason : e;
    }
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
    if (!response.ok || p === "systemone") {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        touch();
        bytes += chunk.length;
        if (bytes > 2_000_000)
          throw Object.assign(Error("JSON 响应超过 2MB"), { kind: "output" });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (p !== "systemone") {
        try {
          inspect(JSON.parse(raw));
        } catch {
          /* SDK retains non-JSON error responses. */
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
  try {
    if (p === "systemone") {
      const response = await wrappedFetch(`${base}/systemone/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: c.model, state: q.prompt, questions: c.questions }),
      });
      const raw = await response.text();
      if (!response.ok)
        throw Object.assign(Error(`System One HTTP ${response.status}`), {
          statusCode: response.status, responseBody: raw,
        });
      let decision;
      try {
        decision = JSON.parse(raw);
      } catch {
        throw Object.assign(Error("System One 返回的内容不是有效 JSON"), { kind: "output" });
      }
      inspect(decision);
      if (capture.apiError) throw capture.apiError;
      capture.partial = JSON.stringify(decision?.answers ?? {});
      for (const [id, question] of Object.entries(c.questions)) {
        const answer = decision?.answers?.[id];
        if (answer?.type !== "choice" || typeof answer.choice !== "string" ||
            !Object.hasOwn(question.criteria, answer.choice) ||
            !Object.keys(question.criteria).every((option) => {
              const probability = answer.probabilities?.[option];
              return Number.isFinite(probability) && probability >= 0 && probability <= 1;
            }))
          throw Object.assign(Error(`System One 问题 ${id} 缺少有效答案或完整选项概率`), { kind: "output" });
      }
      return { ...capture, decision, finishReason: "stop", toolCalls: [] };
    }
    let model;
    const settings = { apiKey: key, fetch: wrappedFetch };
    if (p === "chat")
      model = c.provider === "openai"
        ? createOpenAI({ ...settings, baseURL: base }).chat(c.model)
        : createOpenAICompatible({
            ...settings,
            name: c.provider,
            baseURL: c.provider === "opencode" ? `${base}/openai/v1` : base,
            includeUsage: true,
          })(c.model);
    if (p === "responses")
      model = createOpenAI({
        ...settings,
        baseURL: c.provider === "openai" ? base : `${base}/openai/v1`,
      }).responses(c.model);
    if (p === "anthropic")
      model = createAnthropic({
        ...settings,
        headers: { Authorization: `Bearer ${key}` },
        baseURL: `${base}/anthropic/v1`,
      })(c.model);
    if (p === "google")
      model = createGoogleGenerativeAI({
        ...settings,
        headers: { Authorization: `Bearer ${key}` },
        baseURL: `${base}/google/v1beta`,
      })(c.model);
    const options = {};
    for (const k of [
      "temperature",
      "topP",
      "topK",
      "maxOutputTokens",
      "presencePenalty",
      "frequencyPenalty",
      "seed",
      "stopSequences",
      "providerOptions",
    ])
      if (c[k] !== undefined) options[k] = c[k];
    const result = streamText({
      model,
      ...options,
      ...(q.messages ? { messages: q.messages } : { prompt: q.prompt }),
      maxRetries: 0,
      abortSignal: combined,
      onError: () => {},
    });
    let finish = null;
    const toolCalls = [];
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error;
      if (part.type === "abort")
        throw combined.reason || timeoutError("流被中断");
      if (part.type === "start-step" && part.warnings?.length)
        throw Object.assign(
          Error(`不支持参数: ${JSON.stringify(part.warnings)}`),
          { kind: "parameter" },
        );
      if (part.type === "text-delta") capture.partial += part.text;
      if (part.type === "reasoning-delta") capture.reasoning += part.text;
      if (part.type === "tool-call") toolCalls.push(part);
      if (capture.partial.length + capture.reasoning.length > 8_000_000)
        throw Object.assign(Error("输出超过本地 8M 字符上限"), {
          kind: "output",
        });
      if (part.type === "finish") finish = part.finishReason;
    }
    if (capture.apiError) throw capture.apiError;
    const warnings = await result.warnings;
    if (warnings?.length)
      throw Object.assign(Error(`不支持参数: ${JSON.stringify(warnings)}`), {
        kind: "parameter",
      });
    if (!finish || finish === "unknown" || finish === "error")
      throw timeoutError("响应流未正常结束");
    if (finish === "content-filter")
      throw Object.assign(Error("内容审核拦截"), { kind: "content" });
    if (finish === "length")
      throw Object.assign(Error("输出达到长度上限"), { kind: "output" });
    if (!capture.partial && !toolCalls.length)
      throw Object.assign(Error("模型未返回有效文本"), { kind: "output" });
    if (capture.logprobs && capture.partial && !capture.logprobs.content.length)
      throw Object.assign(Error("请求了 logprobs，但模型没有返回输出 Token 概率"), { kind: "parameter" });
    const u = await result.totalUsage;
    if (u)
      capture.usage = {
        ...capture.usage,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        totalTokens: u.totalTokens,
      };
    return { ...capture, finishReason: finish, toolCalls };
  } catch (e) {
    const error = combined.aborted ? combined.reason
      : capture.contentFilter
        ? Object.assign(Error(`内容审核拦截: ${capture.contentFilter.reason}`), { kind: "content" })
        : e;
    error.capture = capture;
    throw error;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    controller.abort();
  }
}
