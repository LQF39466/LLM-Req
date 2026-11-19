function errorKind(error, provider) {
  if (error.code === "MISSING_API_KEY") return "auth";
  if (error.kind) return error.kind;
  const status = Number(error.statusCode ?? error.status);
  if (status === 401) return "auth";
  const msg = [error.message, error.responseBody]
    .filter(Boolean)
    .join(" ")
    .slice(0, 12000);
  let cause = error;
  const codes = [];
  for (let i = 0; cause && i < 8; i++, cause = cause.cause)
    codes.push(cause.code, cause.name);
  if (
    /content.?filter|data.?inspection|inappropriate|content.?policy|blocked.*safety|safety.*(?:block|filter)|内容.*拦截/i.test(
      msg,
    ) ||
    (status === 421 && provider === "mimo")
  )
    return "content";
  // AllocationQuota / insufficient_quota can mean TPM at Bailian: never infer balance from that alone.
  if (
    status === 402 ||
    (provider === "openai" && /insufficient_quota/i.test(msg)) ||
    /arrearage|insufficient.?balance|credit.balance.exhausted|余额不足|payment.required|plan.*exhaust|套餐.*耗尽/i.test(
      msg,
    )
  )
    return "quota";
  if (
    status === 429 ||
    /throttl|rate.?limit|limit_requests|limit_burst|allocationquota|insufficient_quota/i.test(
      msg,
    )
  )
    return "rate";
  if (status === 403) return "auth";
  // OpenCode wraps an upstream response/adapter failure in HTTP 400.
  // The envelope is valid JSON; this does not mean the user's parameters are invalid.
  if (/upstream request failed/i.test(msg) && /upstream response was not valid JSON/i.test(msg))
    return "transient";
  if (
    ["AI_InvalidArgumentError", "AI_InvalidPromptError", "AI_UnsupportedFunctionalityError"].includes(error.name) ||
    status === 400 ||
    status === 404 ||
    status === 422 ||
    /UnsupportedParameter|InvalidParameter|unsupported.*setting|未知配置|不支持参数/i.test(
      msg,
    )
  )
    return "parameter";
  if (
    codes.some((c) =>
      [
        "CERT_HAS_EXPIRED",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ].includes(c),
    )
  )
    return "configuration";
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
    return "unsent";
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
    return "interrupted";
  if (status >= 500 || status === 409 || error.isRetryable === true)
    return "transient";
  return "unknown";
}

export function classify(error, provider) {
  const kind = errorKind(error, provider);
  const count = kind !== "rate" && kind !== "unsent" && error.code !== "MISSING_API_KEY";
  return { kind, count };
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
      next: now + (kind === "rate" ? retryAfter || 60_000 : Math.max(retryAfter, 300_000)),
    };
  if (attempts >= 3) return { state: "held", next: 0 };
  if (kind === "interrupted")
    return interruptions >= 2
      ? { state: "held", next: 0 }
      : { state: "waiting", next: now + Math.max(300_000, retryAfter) };
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
