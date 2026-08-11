export function googleSearchUrl(name) {
  return `https://www.google.com/search?q=${encodeURIComponent(`${name} API key env var`)}`;
}

export function formatLink(label, url) {
  const linked = terminalLink(label, url);
  return linked === url ? url : `${linked} (${url})`;
}

export function terminalLink(label, url) {
  if (!supportsHyperlinks()) return url;
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

function supportsHyperlinks() {
  if (!process.stdout.isTTY) return false;
  if (process.env.FORCE_HYPERLINK === "1") return true;
  if (process.env.FORCE_HYPERLINK === "0") return false;
  const termProgram = process.env.TERM_PROGRAM || "";
  return ["iTerm.app", "WezTerm", "vscode", "Apple_Terminal", "Tabby"].includes(termProgram) ||
    Boolean(process.env.WT_SESSION);
}
