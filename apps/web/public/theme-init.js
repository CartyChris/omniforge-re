// Applies the saved theme before first paint (no flash). External file so it runs under the production CSP (script-src 'self').
// omniforge.themeVars is written by src/lib/themes.ts; only known variable names with plain colour values are applied.
try {
  var d = document.documentElement, t = localStorage.getItem("omniforge.theme");
  if (t === "light" || t === "dark") d.setAttribute("data-theme", t);
  var v = JSON.parse(localStorage.getItem("omniforge.themeVars") || "null");
  var ok = /^(bg|surface|elevated|overlay|line|line-strong|fg|muted|faint|teal|ok|warn|bad|info|accent|accent-fg|accent-soft)$/;
  if (v && typeof v === "object") for (var k in v) if (ok.test(k) && /^[#\w\s(),.%-]{1,80}$/.test(String(v[k]))) d.style.setProperty("--" + k, String(v[k]));
} catch (e) {}
