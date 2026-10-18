// Applies the saved theme before first paint (no flash). External file so it runs under the production CSP (script-src 'self').
try { var t = localStorage.getItem("omniforge.theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) {}
