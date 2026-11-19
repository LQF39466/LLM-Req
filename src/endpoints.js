// A custom provider is enabled by a server-side LLM_<NAME>_BASE_URL.
const builtins = {
  openai: { baseURL: "https://api.openai.com/v1", protocols: ["responses", "chat"] },
  deepseek: { baseURL: "https://api.deepseek.com/v1", protocols: ["chat"] },
  mimo: { baseURL: "https://api.xiaomimimo.com/v1", protocols: ["chat"] },
  bailian: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocols: ["chat"] },
  anthropic: { baseURL: "https://api.anthropic.com/v1", protocols: ["anthropic"] },
  google: { baseURL: "https://generativelanguage.googleapis.com/v1beta", protocols: ["google"] },
  opencode: {
    baseURL: "https://opencode.ai/inference",
    protocols: ["chat", "responses", "anthropic", "google", "systemone"],
  },
};
const gatewayPaths = {
  chat: "/openai/v1", responses: "/openai/v1",
  anthropic: "/anthropic/v1", google: "/google/v1beta", systemone: "/systemone/v1",
};
const decisionModels = new Set(["gemini-decision-1", "jev-1.13"]);

export function usesSystemOne(c) {
  return c.provider === "opencode" && (c.protocol === "systemone" || decisionModels.has(c.model));
}

function envPrefix(provider) {
  const prefix = Object.hasOwn(builtins, provider) ? "" : "LLM_";
  return prefix + provider.toUpperCase();
}

export function keyVariable(provider) {
  return envPrefix(provider) + "_API_KEY";
}

export function endpoint(c) {
  if (typeof c.provider !== "string" || Object.hasOwn(Object.prototype, c.provider) || !/^[a-z][a-z0-9_]*$/.test(c.provider))
    throw Error("未知 provider");
  const preset = builtins[c.provider];
  const protocols = preset?.protocols ?? ["chat", "responses", "anthropic", "google"];
  const prefix = envPrefix(c.provider);
  const base = process.env[prefix + "_BASE_URL"]?.trim() || preset?.baseURL;
  if (!base) throw Error(`未知 provider ${c.provider}，请配置 ${prefix}_BASE_URL`);
  let protocol = c.protocol === undefined ? protocols[0] : c.protocol;
  if (usesSystemOne(c)) {
    if (c.protocol !== undefined && c.protocol !== "systemone")
      throw Error("该 OpenCode 决策模型使用 systemone 协议");
    protocol = "systemone";
  } else if (c.provider === "opencode" && c.protocol === undefined) {
    if (/^(claude|qwen)/i.test(c.model)) protocol = "anthropic";
    else if (/^(gpt|o[134](?:-|$))/i.test(c.model)) protocol = "responses";
    else if (/^gemini/i.test(c.model)) protocol = "google";
  }
  if (!protocols.includes(protocol))
    throw Error(`${c.provider === "openai" ? "OpenAI" : c.provider} 仅支持 ${protocols.join(" / ")} 协议`);
  const baseURL = base.replace(/\/+$/, "") + (c.provider === "opencode" ? gatewayPaths[protocol] : "");
  return { baseURL, protocol, custom: !preset };
}
