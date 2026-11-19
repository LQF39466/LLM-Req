export const defaults = {
  connectMs: 60_000,
  idleMs: 300_000,
  totalMs: 1_800_000,
};
const systemOneModels = new Set(["gemini-decision-1", "jev-1.13"]);
export function usesSystemOne(config) {
  return config.provider === "opencode" &&
    (config.protocol === "systemone" || systemOneModels.has(config.model));
}

const allowed = new Set([
  "provider",
  "model",
  "protocol",
  "questions",
  "temperature",
  "topP",
  "topK",
  "maxOutputTokens",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
  "stopSequences",
  "logprobs",
  "topLogprobs",
  "thinking",
  "providerOptions",
  "extraBody",
  "timeout",
]);
// Keep the stored/public config intact; normalize only when validating/assembling.
export function normalizeThinking(thinking) {
  if (thinking === undefined) return undefined;
  if (typeof thinking === "string") {
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking))
      throw Error("thinking 必须是 off/minimal/low/medium/high/xhigh/max");
    return thinking === "off"
      ? { enabled: false }
      : { enabled: true, effort: thinking };
  }
  if (
    !thinking ||
    typeof thinking !== "object" ||
    Array.isArray(thinking)
  )
    throw Error("thinking 必须是强度字符串或旧版对象");
  for (const k of Object.keys(thinking))
    if (!["enabled", "budget", "effort"].includes(k))
      throw Error(`未知 thinking 参数 ${k}`);
  if (typeof thinking.enabled !== "boolean")
    throw Error("thinking.enabled 必须是 boolean");
  if (
    thinking.budget !== undefined &&
    (!Number.isInteger(thinking.budget) || thinking.budget < 1)
  )
    throw Error("thinking.budget 必须为正整数");
  if (
    thinking.effort !== undefined &&
    !["minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking.effort)
  )
    throw Error("thinking.effort 无效");
  return thinking;
}
export function validateConfig(c) {
  if (!c || typeof c !== "object" || Array.isArray(c))
    throw Error("config 必须是对象");
  for (const key of Object.keys(c))
    if (!allowed.has(key)) throw Error(`未知配置参数: ${key}`);
  if (!["deepseek", "mimo", "bailian", "opencode", "openai"].includes(c.provider))
    throw Error("未知 provider");
  if (typeof c.model !== "string" || !c.model.trim()) throw Error("model 必填");
  if (
    c.protocol &&
    !["chat", "responses", "anthropic", "google", "systemone"].includes(c.protocol)
  )
    throw Error("protocol 无效");
  if (c.provider === "openai" && c.protocol && !["chat", "responses"].includes(c.protocol))
    throw Error("OpenAI 官方接口仅支持 chat / responses 协议");
  if (!["opencode", "openai"].includes(c.provider) && c.protocol && c.protocol !== "chat")
    throw Error("当前该平台适配器使用 chat 协议");
  if (usesSystemOne(c)) {
    if (c.protocol && c.protocol !== "systemone")
      throw Error("该 OpenCode 决策模型使用 systemone 协议");
    for (const key of Object.keys(c))
      if (!["provider", "model", "protocol", "questions", "timeout"].includes(key))
        throw Error(`systemone 不支持配置参数 ${key}`);
    if (!c.questions || typeof c.questions !== "object" || Array.isArray(c.questions) ||
        !Object.keys(c.questions).length)
      throw Error("systemone questions 必须是非空对象");
    for (const [id, question] of Object.entries(c.questions)) {
      if (!id.trim() || question?.type !== "choice" ||
          typeof question.instructions !== "string" || !question.instructions.trim() ||
          !question.criteria || typeof question.criteria !== "object" ||
          Array.isArray(question.criteria) || Object.keys(question.criteria).length < 2 ||
          Object.keys(question.criteria).some((option) => !option.trim()))
        throw Error(`systemone 问题 ${id} 必须为含说明及至少两个选项的 choice`);
    }
  } else if (c.questions !== undefined) {
    throw Error("questions 仅用于 OpenCode systemone");
  }
  for (const k of [
    "temperature",
    "topP",
    "topK",
    "maxOutputTokens",
    "presencePenalty",
    "frequencyPenalty",
    "seed",
  ])
    if (
      c[k] !== undefined &&
      (typeof c[k] !== "number" || !Number.isFinite(c[k]))
    )
      throw Error(`${k} 必须是有限数值`);
  for (const k of ["maxOutputTokens", "topK"])
    if (c[k] !== undefined && (!Number.isInteger(c[k]) || c[k] < 1))
      throw Error(`${k} 必须是正整数`);
  if (c.topP !== undefined && (c.topP < 0 || c.topP > 1))
    throw Error("topP 超出范围");
  if (c.temperature !== undefined && c.temperature < 0)
    throw Error("temperature 不得为负");
  if (c.logprobs !== undefined && typeof c.logprobs !== "boolean")
    throw Error("logprobs 必须是 boolean");
  if (c.topLogprobs !== undefined &&
      (!Number.isInteger(c.topLogprobs) || c.topLogprobs < 0 || c.topLogprobs > 20))
    throw Error("topLogprobs 必须是 0–20 的整数");
  if (c.topLogprobs !== undefined && c.logprobs !== true)
    throw Error("topLogprobs 需要 logprobs: true");
  if (c.provider === "bailian" && c.topLogprobs > 5)
    throw Error("百炼 topLogprobs 最大为 5");
  if (c.logprobs !== undefined && (c.extraBody?.logprobs !== undefined ||
      c.extraBody?.top_logprobs !== undefined || c.providerOptions?.openai?.logprobs !== undefined))
    throw Error("统一 logprobs 不能与原生 logprobs 配置混用");
  if (
    c.stopSequences !== undefined &&
    (!Array.isArray(c.stopSequences) ||
      !c.stopSequences.every((x) => typeof x === "string"))
  )
    throw Error("stopSequences 必须是字符串数组");
  normalizeThinking(c.thinking);
  for (const key of ["extraBody", "providerOptions", "timeout"])
    if (
      c[key] !== undefined &&
      (!c[key] || typeof c[key] !== "object" || Array.isArray(c[key]))
    )
      throw Error(`${key} 必须是对象`);
  const reserved = [
    "model",
    "messages",
    "input",
    "contents",
    "stream",
    "stream_options",
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "seed",
    "stop",
    "presence_penalty",
    "frequency_penalty",
  ];
  for (const key of Object.keys(c.extraBody || {}))
    if (reserved.includes(key)) throw Error(`extraBody 不允许覆盖 ${key}`);
  for (const [k, v] of Object.entries(c.timeout || {}))
    if (!(k in defaults) || !Number.isInteger(v) || v < 1000 || v > 2147483647)
      throw Error(`timeout.${k} 无效`);
  return c;
}
export function validateQuery(q) {
  if (!q || typeof q !== "object" || Array.isArray(q))
    throw Error("query 必须是对象");
  for (const k of Object.keys(q))
    if (!["id", "batch", "prompt", "messages", "metadata"].includes(k))
      throw Error(`未知 query 字段 ${k}`);
  if (typeof q.id !== "string" || !q.id || q.id.length > 256)
    throw Error("query.id 必须是 1–256 字符字符串");
  if ((typeof q.prompt === "string") === Array.isArray(q.messages))
    throw Error("query 必须且只能包含 prompt 或 messages");
  if (
    q.messages &&
    (!q.messages.length ||
      !q.messages.every(
        (m) =>
          m &&
          ["system", "user", "assistant", "tool"].includes(m.role) &&
          (typeof m.content === "string" || Array.isArray(m.content)),
      ))
  )
    throw Error("messages 格式无效");
  return q;
}
export function canonical(x) {
  return JSON.stringify(sort(x));
}
function sort(x) {
  return Array.isArray(x)
    ? x.map(sort)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sort(x[k])]),
        )
      : x;
}
export function classify(error) {
  if (error.code === "MISSING_API_KEY") return { kind: "auth", count: false };
  const status = error.statusCode || error.status;
  const msg = [error.message, error.responseBody]
    .filter(Boolean)
    .join(" ")
    .slice(0, 12000);
  let cause = error;
  const codes = [];
  for (let i = 0; cause && i < 8; i++, cause = cause.cause)
    codes.push(cause.code, cause.name);
  if (
    error.kind === "content" ||
    /content.?filter|data.?inspection|inappropriate|content.?policy|blocked.*safety|safety.*(?:block|filter)|内容.*拦截/i.test(
      msg,
    ) ||
    status === 421
  )
    return { kind: "content", count: true };
  // AllocationQuota / insufficient_quota can mean TPM at Bailian: never infer balance from that alone.
  if (
    status === 402 ||
    /arrearage|insufficient.?balance|credit.balance.exhausted|余额不足|payment.required|plan.*exhaust|套餐.*耗尽/i.test(
      msg,
    )
  )
    return { kind: "quota", count: true };
  if (
    status === 429 ||
    /throttl|rate.?limit|limit_requests|limit_burst|allocationquota|insufficient_quota/i.test(
      msg,
    )
  )
    return { kind: "rate", count: false };
  if (status === 401 || status === 403) return { kind: "auth", count: true };
  // OpenCode wraps an upstream response/adapter failure in HTTP 400.
  // The envelope is valid JSON; this does not mean the user's parameters are invalid.
  if (/upstream request failed/i.test(msg) && /upstream response was not valid JSON/i.test(msg))
    return { kind: "transient", count: true };
  if (
    status === 400 ||
    status === 404 ||
    status === 422 ||
    /UnsupportedParameter|InvalidParameter|unsupported.*setting|未知配置|不支持参数/i.test(
      msg,
    )
  )
    return { kind: "parameter", count: true };
  if (
    codes.some((c) =>
      [
        "CERT_HAS_EXPIRED",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ].includes(c),
    )
  )
    return { kind: "configuration", count: true };
  if (
    codes.some((c) =>
      [
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "UND_ERR_CONNECT_TIMEOUT",
      ].includes(c),
    )
  )
    return { kind: "unsent", count: false };
  if (
    status === 408 ||
    status === 504 ||
    error.name === "TimeoutError" ||
    codes.some((c) =>
      [
        "ECONNRESET",
        "EPIPE",
        "UND_ERR_SOCKET",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(c),
    ) ||
    /fetch failed|terminated|network|premature|stream.*(closed|ended)/i.test(
      msg,
    )
  )
    return { kind: "interrupted", count: true };
  if (status >= 500 || status === 408)
    return { kind: "transient", count: true };
  if (error.kind) return { kind: error.kind, count: true };
  return { kind: "unknown", count: true };
}
export function decide(
  kind,
  attempts,
  interruptions,
  now = Date.now(),
  retryAfter = 0,
) {
  if (kind === "content") return { state: "succeeded", next: 0 };
  if (kind === "rate" || kind === "unsent")
    return {
      state: "waiting",
      next: now + Math.max(retryAfter, kind === "rate" ? 60_000 : 300_000),
    };
  if (attempts >= 3) return { state: "held", next: 0 };
  if (kind === "interrupted")
    return interruptions >= 2
      ? { state: "held", next: 0 }
      : { state: "waiting", next: now + 300_000 };
  if (kind === "transient")
    return {
      state: "waiting",
      next:
        now +
        Math.max(
          retryAfter,
          2000 * 2 ** (attempts - 1) + Math.floor(Math.random() * 1000),
        ),
    };
  return { state: "held", next: 0 };
}

// Keep original partial output for inspection; consumers must honor the filter flag.
export function contentFilteredResult(capture, reason) {
  return {
    ...capture,
    partial: capture.partial || "",
    reasoning: capture.reasoning || "",
    finishReason: "content-filter",
    contentFiltered: true,
    contentFilter: reason,
  };
}
