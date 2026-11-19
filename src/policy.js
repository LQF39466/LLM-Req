import { endpoint } from "./endpoints.js";
export { usesSystemOne } from "./endpoints.js";

export const defaults = {
  connectMs: 60_000,
  idleMs: 300_000,
  totalMs: 1_800_000,
};
const allowed = new Set([
  "provider",
  "model",
  "protocol",
  "stream",
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
  if (typeof c.model !== "string" || !c.model.trim()) throw Error("model 必填");
  const { protocol } = endpoint(c);
  if (c.stream !== undefined && typeof c.stream !== "boolean") throw Error("stream 必须是 boolean");
  if (protocol === "systemone") {
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
  if (c.logprobs === true && !["chat", "responses"].includes(protocol))
    throw Error(`当前 ${protocol} 协议不支持统一 logprobs`);
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

export { classify, decide, contentFilteredResult } from "./retry.js";
