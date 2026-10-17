/**
 * Feature inventory. A feature is only reported when concrete, recorded
 * evidence supports it. Behaviour specs describe what was OBSERVED and label
 * everything else "Unknown:" — interaction-level behaviour needs rendered
 * analysis or an authorised interactive session.
 */
import type { BehaviorSpec, Evidence, EvidenceKind, Feature } from "../schema.js";
import { hashStr, now, uid } from "../util/index.js";
import type { Facts } from "./facts.js";

const UNKNOWN_STATES = "Unknown: runtime UI states require rendered or interactive analysis";
const UNKNOWN_ERRORS = "Unknown: server-side validation and error responses were not exercised";

function spec(partial: Partial<BehaviorSpec> & Pick<BehaviorSpec, "purpose">): BehaviorSpec {
  return {
    inputs: [],
    outputs: [],
    states: [UNKNOWN_STATES],
    transitions: [],
    dependencies: [],
    errorStates: [UNKNOWN_ERRORS],
    accessibility: [],
    hypotheses: [],
    ...partial,
  };
}

export function inferFeatures(f: Facts): { features: Feature[]; evidence: Evidence[] } {
  const features: Feature[] = [];
  const evidence: Evidence[] = [];
  const techNames = new Set(f.technologies.map((t) => t.name));
  const hasTech = (...n: string[]) => n.some((x) => techNames.has(x));
  const techEvidence = (...n: string[]) => f.technologies.filter((t) => n.includes(t.name)).flatMap((t) => t.evidence);

  const ev = (kind: EvidenceKind, method: string, source: string, summary: string, confidence: number, related: string[] = [], snippet?: string): string => {
    const e: Evidence = { id: uid("ev"), kind, method, source, timestamp: now(), confidence, summary, snippet, related };
    evidence.push(e);
    return e.id;
  };

  const add = (name: string, category: string, description: string, o: { pages?: string[]; files?: string[]; evidence: string[]; confidence: number; provenance?: EvidenceKind; spec: BehaviorSpec }) => {
    features.push({
      id: `ft_${hashStr(name + category).slice(0, 10)}`,
      name,
      category,
      description,
      pages: [...new Set(o.pages ?? [])].slice(0, 50),
      files: [...new Set(o.files ?? [])].slice(0, 50),
      evidence: [...new Set(o.evidence)],
      confidence: Math.round(o.confidence * 100) / 100,
      provenance: o.provenance ?? "inferred",
      spec: o.spec,
    });
  };

  const pagesWhere = (pred: (e: NonNullable<ReturnType<Facts["extracted"]["get"]>>) => boolean) =>
    f.pages.filter((p) => {
      const e = f.extracted.get(p.url);
      return e ? pred(e) : false;
    });
  const pid = (p: { id: string }) => p.id;
  const allJs = [...f.js.entries()];
  const jsHas = (re: RegExp) => allJs.filter(([, a]) => a.imports.some((i) => re.test(i)) || a.functions.some((n) => re.test(n)) || a.events.some((e) => re.test(e)));

  /* ---- Navigation ---- */
  const navPages = pagesWhere((e) => e.navLinks.length >= 3);
  if (navPages.length) {
    const sample = f.extracted.get(navPages[0]!.url)!;
    const e1 = ev("observed", "html-structure", navPages[0]!.url, `Navigation landmark with ${sample.navLinks.length} links on ${navPages.length} page(s)`, 0.95, navPages.map(pid), sample.navLinks.slice(0, 6).map((l) => `${l.text} → ${l.href}`).join("\n"));
    add("Site navigation", "Navigation", `Primary navigation exposing ${sample.navLinks.length} destinations, present on ${navPages.length} page(s).`, {
      pages: navPages.map(pid), evidence: [e1], confidence: 0.95, provenance: "observed",
      spec: spec({
        purpose: "Move between sections of the site.",
        inputs: ["Click/tap on navigation links", "Keyboard focus + Enter"],
        outputs: sample.navLinks.slice(0, 12).map((l) => `Navigates to ${l.href}${l.text ? ` (“${l.text}”)` : ""}`),
        transitions: sample.navLinks.slice(0, 12).map((l) => `current page → ${l.href}`),
        accessibility: [sample.landmarks.includes("nav") || sample.landmarks.includes("navigation") ? "Uses a navigation landmark" : "No navigation landmark found"],
      }),
    });
  }

  /* ---- Authentication ---- */
  const pwPages = pagesWhere((e) => e.signals.passwordInputs > 0);
  const authTech = ["Auth0", "Clerk", "NextAuth.js / Auth.js", "Okta", "Amazon Cognito", "Google Sign-In", "Firebase", "Supabase"].filter((t) => techNames.has(t));
  const loginRoutes = f.pages.filter((p) => /\/(log-?in|sign-?in|signup|sign-?up|register|auth)(\/|$)/i.test(new URL(p.url).pathname));
  if (pwPages.length || loginRoutes.length || authTech.length) {
    const ids: string[] = [];
    for (const p of pwPages) ids.push(ev("observed", "html-structure", p.url, "Password input present", 0.95, [p.id]));
    for (const p of loginRoutes) ids.push(ev("observed", "route-name", p.url, "Authentication-style route", 0.7, [p.id]));
    ids.push(...techEvidence(...authTech));
    const form = pwPages[0] ? f.extracted.get(pwPages[0].url)!.forms.find((fm) => fm.fields.some((x) => x.type === "password")) : undefined;
    add("Authentication", "Accounts", `User sign-in${authTech.length ? ` using ${authTech.join(", ")}` : ""}.`, {
      pages: [...pwPages, ...loginRoutes].map(pid), evidence: ids, confidence: pwPages.length ? 0.9 : 0.7,
      spec: spec({
        purpose: "Identify a returning user and start an authenticated session.",
        inputs: form ? form.fields.filter((x) => x.type !== "hidden").map((x) => `${x.name || x.type} (${x.type}${x.required ? ", required" : ""})`) : ["Unknown: credential form not found in static HTML"],
        outputs: ["Unknown: session establishment is server-side (cookie/token) and was not exercised"],
        dependencies: authTech,
        hypotheses: authTech.length ? [`Delegates identity to ${authTech.join(" / ")} (inferred from client assets)`] : ["Uses a first-party credential endpoint (inferred from password form)"],
        accessibility: form ? [form.fields.some((x) => !x.label) ? "Some fields lack visible/ARIA labels" : "All fields labelled"] : [],
      }),
    });
  }

  /* ---- Search ---- */
  const searchPages = pagesWhere((e) => e.signals.searchInputs > 0);
  if (searchPages.length || hasTech("Algolia")) {
    const ids = searchPages.map((p) => ev("observed", "html-structure", p.url, "Search input present", 0.9, [p.id]));
    ids.push(...techEvidence("Algolia"));
    add("Search", "Discovery", `Search input found on ${searchPages.length} page(s)${hasTech("Algolia") ? "; Algolia client present" : ""}.`, {
      pages: searchPages.map(pid), evidence: ids, confidence: searchPages.length ? 0.9 : 0.6, provenance: searchPages.length ? "observed" : "inferred",
      spec: spec({
        purpose: "Find content by free-text query.",
        inputs: ["Search query text"],
        outputs: ["Unknown: result rendering (instant vs. submit-based) not exercised"],
        dependencies: hasTech("Algolia") ? ["Algolia"] : [],
        hypotheses: hasTech("Algolia") ? ["Queries are sent to Algolia’s hosted index"] : ["Queries are handled by a first-party endpoint"],
      }),
    });
  }

  /* ---- Forms ---- */
  const seenForm = new Set<string>();
  for (const p of f.pages) {
    const e = f.extracted.get(p.url);
    if (!e) continue;
    for (const fm of e.forms) {
      const fields = fm.fields.filter((x) => !["hidden", "submit", "button"].includes(x.type));
      if (fields.length < 1 || fields.some((x) => x.type === "password") || fields.some((x) => x.type === "search")) continue;
      const key = `${fm.method}:${fm.action}`;
      if (seenForm.has(key)) continue;
      seenForm.add(key);
      const eid = ev("observed", "html-structure", p.url, `Form → ${fm.method.toUpperCase()} ${fm.action} with ${fields.length} field(s)`, 0.95, [p.id], fields.map((x) => `${x.name}:${x.type}`).join(", "));
      add(`Form: ${new URL(fm.action).pathname || "/"}`, "Forms", `Data-capture form (${fm.method.toUpperCase()}) with ${fields.length} field(s).`, {
        pages: [p.id], evidence: [eid], confidence: 0.95, provenance: "observed",
        spec: spec({
          purpose: "Collect user input and submit it to the server.",
          inputs: fields.map((x) => `${x.label || x.name || x.type} (${x.type}${x.required ? ", required" : ""})`),
          outputs: [`${fm.method.toUpperCase()} request to ${fm.action}`],
          transitions: ["idle → submitting → (success | error): Unknown which UI states follow"],
          accessibility: [fields.every((x) => x.label) ? "All fields have labels" : `${fields.filter((x) => !x.label).length} field(s) without label/aria-label/placeholder`],
        }),
      });
    }
  }

  /* ---- Dialogs ---- */
  const dlg = pagesWhere((e) => e.interactive.dialogs > 0);
  if (dlg.length) {
    add("Modal dialogs", "UI patterns", `Dialog elements present on ${dlg.length} page(s).`, {
      pages: dlg.map(pid), confidence: 0.85, provenance: "observed",
      evidence: dlg.map((p) => ev("observed", "html-structure", p.url, "dialog / role=dialog / aria-modal element", 0.85, [p.id])),
      spec: spec({ purpose: "Show focused content or confirmation above the page.", inputs: ["Unknown: opening triggers"], outputs: ["Overlay content"], accessibility: ["Uses dialog semantics (role=dialog or <dialog>)"] }),
    });
  }

  /* ---- Tables, tabs, accordions, carousels, breadcrumbs, pagination (UI patterns) ---- */
  const patterns: [string, (e: NonNullable<ReturnType<Facts["extracted"]["get"]>>) => boolean, string][] = [
    ["Data tables", (e) => e.signals.tables > 0, "Tabular data (<table>)"],
    ["Tabs", (e) => e.signals.tabs > 0, "role=tablist"],
    ["Accordions / disclosure", (e) => e.signals.accordions > 0, "<details> or aria-expanded controls"],
    ["Carousels", (e) => e.signals.carousels > 0, "carousel/swiper class markers"],
    ["Breadcrumbs", (e) => e.signals.breadcrumbs, "breadcrumb landmark"],
    ["Pagination", (e) => e.signals.pagination, "pagination landmark"],
    ["Toasts / live regions", (e) => e.signals.toasts > 0, "role=alert|status or toast class"],
  ];
  for (const [name, pred, what] of patterns) {
    const ps = pagesWhere(pred);
    if (!ps.length) continue;
    add(name, "UI patterns", `${what} found on ${ps.length} page(s).`, {
      pages: ps.map(pid), confidence: 0.8, provenance: "observed",
      evidence: ps.slice(0, 5).map((p) => ev("observed", "html-structure", p.url, what, 0.8, [p.id])),
      spec: spec({ purpose: `${name} interaction pattern.`, inputs: ["Unknown: interaction handlers not exercised"], outputs: ["Unknown"], accessibility: [] }),
    });
  }

  /* ---- Visualisation / graphs ---- */
  const vizTech = ["D3", "Chart.js", "ECharts", "React Flow"].filter((t) => techNames.has(t));
  const canvasPages = pagesWhere((e) => e.signals.canvas > 0);
  if (vizTech.length || canvasPages.length) {
    const ids = [...techEvidence(...vizTech), ...canvasPages.map((p) => ev("observed", "html-structure", p.url, "<canvas> element", 0.6, [p.id]))];
    const isGraph = hasTech("React Flow");
    add(isGraph ? "Interactive node graph" : "Data visualisation", "Visualisation", `${vizTech.length ? vizTech.join(", ") : "Canvas rendering"} detected.`, {
      pages: canvasPages.map(pid), evidence: ids, confidence: vizTech.length ? 0.85 : 0.5,
      spec: spec({
        purpose: isGraph ? "Display and edit a node/edge diagram." : "Render data graphically.",
        inputs: isGraph ? ["Drag nodes", "Connect edges", "Pan/zoom"] : ["Unknown: data source and interactions"],
        outputs: ["Unknown: data shape rendered"],
        dependencies: vizTech,
        hypotheses: [`Built with ${vizTech.join(", ") || "the Canvas 2D/WebGL API"} (inferred from client assets)`],
      }),
    });
  }

  /* ---- Code / rich editor ---- */
  if (hasTech("Monaco Editor", "CodeMirror")) {
    add("Code editor", "Editors", `Embedded editor: ${["Monaco Editor", "CodeMirror"].filter((t) => techNames.has(t)).join(", ")}.`, {
      evidence: techEvidence("Monaco Editor", "CodeMirror"), confidence: 0.85,
      spec: spec({ purpose: "Edit source text with syntax highlighting.", inputs: ["Keyboard text entry", "Selection/commands"], outputs: ["Edited buffer"], dependencies: ["Monaco Editor", "CodeMirror"].filter((t) => techNames.has(t)) }),
    });
  }

  /* ---- Maps / 3D / media ---- */
  if (hasTech("Mapbox", "Google Maps")) add("Interactive map", "Geospatial", "Embedded map SDK detected.", { evidence: techEvidence("Mapbox", "Google Maps"), confidence: 0.9, spec: spec({ purpose: "Display and navigate geographic data.", inputs: ["Pan/zoom/click"], dependencies: ["Mapbox", "Google Maps"].filter((t) => techNames.has(t)) }) });
  if (hasTech("Three.js", "WebGL")) add("3D / WebGL rendering", "Graphics", "WebGL or Three.js usage detected.", { evidence: techEvidence("Three.js", "WebGL"), confidence: 0.85, spec: spec({ purpose: "Render real-time 3D graphics.", inputs: ["Unknown: camera/pointer interactions"], dependencies: ["Three.js"].filter((t) => techNames.has(t)) }) });
  const videoPages = pagesWhere((e) => e.signals.video > 0);
  if (videoPages.length) add("Video playback", "Media", `<video> elements on ${videoPages.length} page(s).`, { pages: videoPages.map(pid), provenance: "observed", confidence: 0.9, evidence: videoPages.map((p) => ev("observed", "html-structure", p.url, "<video> element", 0.9, [p.id])), spec: spec({ purpose: "Play video.", inputs: ["Play/pause/seek"], outputs: ["Video stream"] }) });

  /* ---- Payments / commerce ---- */
  if (hasTech("Stripe", "PayPal", "Paddle", "Lemon Squeezy", "Shopify")) {
    const t = ["Stripe", "PayPal", "Paddle", "Lemon Squeezy", "Shopify"].filter((x) => techNames.has(x));
    add("Payments / checkout", "Commerce", `Payment provider SDK: ${t.join(", ")}.`, { evidence: techEvidence(...t), confidence: 0.9, spec: spec({ purpose: "Take payment or manage a subscription.", inputs: ["Card/wallet details entered in provider-hosted fields"], outputs: ["Unknown: order/subscription confirmation flow"], dependencies: t, hypotheses: ["Card data is handled by the provider, not the site (typical for these SDKs)"] }) });
  }

  /* ---- Realtime ---- */
  const wsEndpoints = f.endpoints.filter((e) => e.kind === "websocket" || e.kind === "sse");
  if (wsEndpoints.length || hasTech("Socket.IO", "WebSocket", "Server-Sent Events")) {
    add("Realtime updates", "Data", "Persistent connection (WebSocket / SSE / Socket.IO) used by client code.", {
      evidence: [...techEvidence("Socket.IO", "WebSocket", "Server-Sent Events"), ...wsEndpoints.map((e) => ev("observed", "js-ast", e.foundIn, `${e.kind} endpoint ${e.url}`, 0.9))],
      confidence: 0.85,
      spec: spec({ purpose: "Receive server-pushed updates without polling.", inputs: ["Unknown: subscription messages"], outputs: wsEndpoints.map((e) => `${e.kind} stream ${e.url}`), dependencies: ["Socket.IO"].filter((t) => techNames.has(t)) }),
    });
  }

  /* ---- PWA / offline ---- */
  if (f.manifests.length || f.serviceWorkers.length) {
    const ids = [...f.manifests.map((m) => ev("observed", "http-get", m.url, `Web app manifest${m.name ? ` “${m.name}”` : ""} (${m.icons} icons)`, 0.95)), ...f.serviceWorkers.map((u) => ev("observed", "js-ast", u, "Service worker registration", 0.9))];
    add("Installable / offline app (PWA)", "Platform", `${f.manifests.length ? "Web app manifest" : ""}${f.manifests.length && f.serviceWorkers.length ? " + " : ""}${f.serviceWorkers.length ? "service worker" : ""} present.`, {
      evidence: ids, confidence: 0.9, provenance: "observed",
      spec: spec({ purpose: "Allow install to home screen and cached/offline operation.", inputs: ["Install prompt"], outputs: [f.manifests[0]?.display ? `Display mode: ${f.manifests[0].display}` : "Unknown: display mode"], dependencies: f.serviceWorkers, hypotheses: f.serviceWorkers.length ? ["Caching strategy unknown without reading the worker script"] : [] }),
    });
  }

  /* ---- Drag and drop ---- */
  const dndPages = pagesWhere((e) => e.signals.draggable > 0);
  const dndJs = allJs.filter(([, a]) => a.events.some((x) => /^(dragstart|drop|dragover)$/.test(x)) || a.imports.some((i) => /dnd-kit|react-dnd|sortablejs|dragula/.test(i)));
  if (dndPages.length || dndJs.length) {
    add("Drag and drop", "Interaction", "Drag-and-drop handlers or draggable elements found.", {
      pages: dndPages.map(pid), files: dndJs.map(([u]) => u),
      evidence: [...dndPages.map((p) => ev("observed", "html-structure", p.url, 'draggable="true" elements', 0.8, [p.id])), ...dndJs.map(([u]) => ev("observed", "js-ast", u, "dragstart/drop handlers or DnD library import", 0.8))],
      confidence: 0.8, spec: spec({ purpose: "Reorder or move items by dragging.", inputs: ["Pointer drag", "Unknown: keyboard alternative"], outputs: ["Unknown: persistence of new order"] }),
    });
  }

  /* ---- Command palette ---- */
  const cmdPages = pagesWhere((e) => e.signals.commandHint);
  const cmdJs = jsHas(/cmdk|kbar|command-?palette/i);
  if (cmdPages.length || cmdJs.length) add("Command palette", "Interaction", "Keyboard-invoked command/search palette indicators found.", { pages: cmdPages.map(pid), files: cmdJs.map(([u]) => u), evidence: [...cmdPages.map((p) => ev("observed", "html-structure", p.url, "⌘K hint or combobox/cmdk root", 0.6, [p.id])), ...cmdJs.map(([u]) => ev("observed", "js-ast", u, "cmdk/kbar import", 0.8))], confidence: cmdJs.length ? 0.8 : 0.55, spec: spec({ purpose: "Run commands/navigate via keyboard.", inputs: ["⌘K / Ctrl+K", "Typed query"], outputs: ["Unknown: command set"] }) });

  /* ---- File upload ---- */
  const upPages = pagesWhere((e) => e.signals.fileInputs > 0);
  if (upPages.length) add("File upload", "Data", "File input present.", { pages: upPages.map(pid), provenance: "observed", confidence: 0.95, evidence: upPages.map((p) => ev("observed", "html-structure", p.url, "input[type=file]", 0.95, [p.id])), spec: spec({ purpose: "Let users submit files.", inputs: ["File selection"], outputs: ["Unknown: upload endpoint and limits"] }) });

  /* ---- Theming / i18n / animation ---- */
  const cssAll = [...f.css.entries()];
  const darkCss = cssAll.filter(([, c]) => /prefers-color-scheme\s*:\s*dark|\.dark\b|\[data-theme=["']?dark/.test(c));
  if (darkCss.length) add("Light / dark theming", "Appearance", "CSS defines dark-mode styles.", { files: darkCss.map(([u]) => u), evidence: darkCss.map(([u]) => ev("observed", "css-scan", u, "prefers-color-scheme: dark or .dark selector", 0.9)), confidence: 0.9, provenance: "observed", spec: spec({ purpose: "Adapt colours to light/dark preference.", inputs: ["OS preference", "Unknown: manual toggle"], outputs: ["Alternate colour tokens"] }) });
  const i18n = pagesWhere((e) => e.signals.hreflangs.length >= 2);
  if (i18n.length) add("Internationalisation", "Content", `hreflang alternates: ${i18n[0] ? f.extracted.get(i18n[0].url)!.signals.hreflangs.join(", ") : ""}.`, { pages: i18n.map(pid), provenance: "observed", confidence: 0.95, evidence: i18n.map((p) => ev("observed", "html-structure", p.url, "link rel=alternate hreflang", 0.95, [p.id])), spec: spec({ purpose: "Serve localized versions.", inputs: ["Locale selection / Accept-Language"], outputs: ["Localized pages"] }) });
  const animTech = ["GSAP", "Framer Motion", "Lottie"].filter((t) => techNames.has(t));
  const keyframes = cssAll.reduce((n, [, c]) => n + (c.match(/@keyframes\s/g)?.length ?? 0), 0);
  if (animTech.length || keyframes >= 3) add("Animation system", "Appearance", `${animTech.length ? animTech.join(", ") + "; " : ""}${keyframes} CSS @keyframes.`, { evidence: [...techEvidence(...animTech), ...(keyframes ? [ev("observed", "css-scan", "stylesheets", `${keyframes} @keyframes declarations`, 0.9)] : [])], confidence: 0.8, spec: spec({ purpose: "Animate UI transitions and effects.", inputs: ["Scroll/hover/state changes"], outputs: ["Animated elements"], dependencies: animTech, accessibility: [cssAll.some(([, c]) => /prefers-reduced-motion/.test(c)) ? "Honours prefers-reduced-motion" : "No prefers-reduced-motion handling found in CSS"] }) });

  /* ---- Support chat / analytics ---- */
  if (hasTech("Intercom", "Crisp", "Zendesk", "HubSpot")) { const t = ["Intercom", "Crisp", "Zendesk", "HubSpot"].filter((x) => techNames.has(x)); add("Customer chat / support widget", "Support", `Third-party widget: ${t.join(", ")}.`, { evidence: techEvidence(...t), confidence: 0.9, spec: spec({ purpose: "Let visitors contact support.", inputs: ["Chat messages"], outputs: ["Unknown"], dependencies: t }) }); }
  const analytics = f.technologies.filter((t) => /Analytics|Session replay|Error monitoring|Performance monitoring|Advertising|Tag manager/.test(t.category));
  if (analytics.length) add("Analytics & telemetry", "Telemetry", `${analytics.map((t) => t.name).join(", ")}.`, { evidence: analytics.flatMap((t) => t.evidence), confidence: 0.9, provenance: "observed", spec: spec({ purpose: "Measure usage, errors and performance.", inputs: ["Page views", "Interaction events"], outputs: ["Events sent to third-party collectors"], dependencies: analytics.map((t) => t.name) }) });

  /* ---- Public API surface ---- */
  const apiEps = f.endpoints.filter((e) => e.kind === "rest" || e.kind === "graphql");
  if (apiEps.length) add("Public API surface", "Integration", `${apiEps.length} client-visible endpoint(s).`, { evidence: apiEps.slice(0, 25).map((e) => ev("observed", "js-ast", e.foundIn, `${e.kind.toUpperCase()} ${e.method ?? ""} ${e.url}`.replace(/\s+/g, " "), 0.85)), confidence: 0.85, provenance: "observed", spec: spec({ purpose: "Client↔server data exchange.", inputs: ["Unknown: request payloads"], outputs: apiEps.slice(0, 15).map((e) => `${e.method ?? "?"} ${e.url}`), hypotheses: ["Server implementation is not visible from the client; any backend described here is an independent reimplementation target"] }) });

  return { features, evidence };
}
