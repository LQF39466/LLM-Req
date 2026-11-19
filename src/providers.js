import { generateText, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { requestTransport, timeoutError } from "./request-transport.js";
import { endpoint, keyVariable } from "./endpoints.js";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { normalizeThinking, validateConfig } from "./policy.js";
const credentialSecrets = new Set();
export function refreshCredentials(provider, envPath = ".env") {
  const name = keyVariable(provider);
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
  return endpoint(c).protocol;
}
function parameterError(message) {
  return Object.assign(Error(message), { kind: "parameter" });
}

export function bodyOptions(c, protocol) {
  const body = { ...c.extraBody };
  const thinking = normalizeThinking(c.thinking);
  if (!thinking) return body;
  const { enabled, effort, budget } = thinking;
  const level = enabled ? effort ?? "medium" : "none";

  switch (protocol) {
    case "chat":
      if (c.provider === "bailian") {
        body.enable_thinking = enabled;
        if (budget !== undefined) body.thinking_budget = budget;
      } else if (["deepseek", "mimo", "opencode"].includes(c.provider)) {
        if (budget !== undefined) throw parameterError("此 Chat 端点不支持 thinking.budget");
        body.thinking = { type: enabled ? "enabled" : "disabled" };
      } else {
        if (budget !== undefined) throw parameterError("OpenAI 使用 thinking 强度，不支持 thinking.budget");
        body.reasoning_effort = level;
        break;
      }
      if (effort !== undefined) body.reasoning_effort = effort;
      break;
    case "responses":
      if (budget !== undefined) throw parameterError("Responses 使用 effort，不支持 thinking.budget");
      body.reasoning = { ...body.reasoning, effort: level };
      break;
    case "anthropic":
      if (enabled && effort !== undefined) {
        if (budget !== undefined || effort === "minimal")
          throw parameterError("Anthropic 强度需使用 low/medium/high/xhigh/max，且不能同时设置 budget");
        body.thinking = { type: "adaptive" };
        body.output_config = { ...body.output_config, effort };
      } else {
        if (enabled && !budget) throw parameterError("thinking.budget 为 Anthropic 必填");
        body.thinking = enabled ? { type: "enabled", budget_tokens: budget } : { type: "disabled" };
      }
      break;
    case "google":
      if (enabled && effort !== undefined && (budget !== undefined || !["minimal", "low", "medium", "high"].includes(effort)))
        throw parameterError("Google 强度需使用 minimal/low/medium/high，且不能同时设置 budget");
      body.generationConfig = {
        ...body.generationConfig,
        thinkingConfig: {
          ...(enabled && effort !== undefined ? { thinkingLevel: effort } : { thinkingBudget: enabled ? budget ?? -1 : 0 }),
          includeThoughts: enabled,
        },
      };
      break;
  }
  return body;
}
function redact(message) {
  let s = String(message);
  for (const [name, value] of Object.entries(process.env))
    if (name.endsWith("_API_KEY") && value) s = s.replaceAll(value, "[REDACTED]");
  for (const key of credentialSecrets) s = s.replaceAll(key, "[REDACTED]");
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
function checkOutputSize(capture) {
  if (capture.partial.length + capture.reasoning.length > 8_000_000)
    throw Object.assign(Error("输出超过本地 8M 字符上限"), { kind: "output" });
}

function languageModel(c, protocol, settings) {
  switch (protocol) {
    case "chat":
      if (c.provider === "openai") return createOpenAI(settings).chat(c.model);
      return createOpenAICompatible({ ...settings, name: c.provider, includeUsage: true })(c.model);
    case "responses": return createOpenAI(settings).responses(c.model);
    case "anthropic": return createAnthropic(settings)(c.model);
    case "google": return createGoogleGenerativeAI(settings)(c.model);
  }
}

export async function invoke(c, q, { signal } = {}) {
  const { protocol: p, baseURL, custom } = endpoint(c);
  const extra = bodyOptions(c, p);
  if (p === "systemone") {
    validateConfig(c);
    if (typeof q.prompt !== "string" || !q.prompt.trim() || q.messages !== undefined)
      throw parameterError("systemone 需要使用 query.prompt 提供 state 文本");
  }
  if (c.logprobs === true && !["chat", "responses"].includes(p))
    throw parameterError(`当前 ${p} 协议不支持统一 logprobs`);
  const keyName = keyVariable(c.provider);
  const key = process.env[keyName]?.trim();
  if (!key && !(custom && p === "chat"))
    throw Object.assign(Error(`${keyName} 未配置；请补充 .env 后点击恢复或重试`), {
      kind: "auth", code: "MISSING_API_KEY",
    });
  if (key) credentialSecrets.add(key);
  const transport = requestTransport(c, p, extra, signal);
  const { capture, signal: combined } = transport;
  try {
    if (p === "systemone") {
      const response = await transport.fetch(`${baseURL}/systemone`, {
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
      transport.inspect(decision);
      if (transport.apiError) throw transport.apiError;
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
    const settings = { apiKey: key, baseURL, fetch: transport.fetch };
    if (c.provider === "opencode" && ["anthropic", "google"].includes(p))
      settings.headers = { Authorization: `Bearer ${key}` };
    const model = languageModel(c, p, settings);
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
    const request = {
      model, ...options,
      ...(q.messages ? { messages: q.messages } : { prompt: q.prompt }),
      maxRetries: 0, abortSignal: combined,
    };
    let result, finish;
    if (c.stream === false) {
      result = await generateText(request);
      finish = result.finishReason;
      capture.partial = result.text;
      capture.reasoning = result.reasoningText ?? "";
    } else {
      result = streamText({ ...request, onError: () => {} });
      for await (const part of result.fullStream) {
        if (part.type === "finish") finish = part.finishReason;
        if (part.type === "error") throw part.error;
        if (part.type === "abort") throw combined.reason || timeoutError("流被中断");
        if (part.type === "text-delta") capture.partial += part.text;
        if (part.type === "reasoning-delta") capture.reasoning += part.text;
        checkOutputSize(capture);
      }
    }
    checkOutputSize(capture);
    if (transport.apiError) throw transport.apiError;
    if (!finish || finish === "unknown" || finish === "error")
      throw timeoutError("响应未正常结束");
    const toolCalls = await result.toolCalls;
    const warnings = await result.warnings;
    const unsupported = warnings?.filter(w => w.type === "unsupported" || /not supported|unsupported/i.test(w.message ?? ""));
    if (unsupported?.length)
      throw parameterError(`不支持参数: ${JSON.stringify(unsupported)}`);
    if (warnings?.length) capture.warnings = warnings;
    if (finish === "content-filter")
      throw Object.assign(Error("内容审核拦截"), { kind: "content" });
    if (finish === "length")
      throw Object.assign(Error("输出达到长度上限"), { kind: "output" });
    if (!capture.partial && !toolCalls.length)
      throw Object.assign(Error("模型未返回有效文本"), { kind: "output" });
    if (capture.logprobs && capture.partial && !capture.logprobs.content.length)
      throw parameterError("请求了 logprobs，但模型没有返回输出 Token 概率");
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
    const cause = combined.aborted ? combined.reason
      : capture.contentFilter
        ? Object.assign(Error(`内容审核拦截: ${capture.contentFilter.reason}`), { kind: "content" })
        : transport.apiError ?? e;
    const error = cause instanceof Error ? cause : Error(typeof cause === "string" ? cause : JSON.stringify(cause));
    error.capture = capture;
    throw error;
  } finally {
    transport.close();
  }
}
