export function validationForEnvVar(name, provider) {
  if (!provider) return null;
  const upper = name.toUpperCase();
  const envRule = provider.envSafety?.[upper]?.validation;
  if (envRule) return envRule;
  if (!provider.validation) return null;
  if (provider.validation.env && !provider.validation.env.includes(upper)) return null;
  return provider.validation;
}

export function canValidateEnvVar(name, provider) {
  return Boolean(validationForEnvVar(name, provider));
}

export async function validateEnvValue(name, value, provider, options = {}) {
  const validation = validationForEnvVar(name, provider);
  if (!validation) return { ok: null, message: "No validator available." };

  if (validation.type === "format") {
    const regex = new RegExp(validation.pattern);
    return regex.test(value)
      ? { ok: true, message: validation.success || "Format looks valid." }
      : { ok: false, message: validation.failure || "Value does not match the expected format." };
  }

  if (validation.type === "url") {
    try {
      const parsed = new URL(value);
      if (validation.protocol && parsed.protocol !== validation.protocol) {
        return { ok: false, message: `Expected a ${validation.protocol} URL.` };
      }
      return { ok: true, message: validation.success || "URL looks valid." };
    } catch {
      return { ok: false, message: validation.failure || "Value is not a valid URL." };
    }
  }

  if (validation.type === "http") {
    if (typeof fetch !== "function") {
      return { ok: null, message: "This Node version does not provide fetch." };
    }
    return validateHttp(value, validation, options.timeoutMs || 10000);
  }

  return { ok: null, message: `Unknown validator type: ${validation.type}` };
}

async function validateHttp(secretValue, validation, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(validation.url, {
      method: validation.method || "GET",
      headers: replaceHeaderSecrets(validation.headers || {}, secretValue),
      body: validation.body ? JSON.stringify(replaceBodySecrets(validation.body, secretValue)) : undefined,
      signal: controller.signal
    });
    const okStatuses = validation.okStatus || [200];
    if (okStatuses.includes(response.status)) {
      return { ok: true, message: validation.success || "Provider accepted the value." };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: "Provider rejected the value." };
    }
    if (response.status === 429) {
      return { ok: null, message: "Provider rate-limited validation; value was not shown." };
    }
    return { ok: false, message: `Provider returned HTTP ${response.status}.` };
  } catch (error) {
    if (error.name === "AbortError") return { ok: null, message: "Validation timed out." };
    return { ok: null, message: "Validation failed before the provider returned a response." };
  } finally {
    clearTimeout(timeout);
  }
}

function replaceHeaderSecrets(headers, secretValue) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value).replaceAll("{value}", secretValue)])
  );
}

function replaceBodySecrets(body, secretValue) {
  if (typeof body === "string") return body.replaceAll("{value}", secretValue);
  if (Array.isArray(body)) return body.map((item) => replaceBodySecrets(item, secretValue));
  if (body && typeof body === "object") {
    return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, replaceBodySecrets(value, secretValue)]));
  }
  return body;
}
