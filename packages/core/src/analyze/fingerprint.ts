/**
 * Evidence-based technology fingerprinting.
 *
 * Each rule lists concrete signals. A technology is only reported when at
 * least one signal matches, and every match is recorded as Evidence with
 * the matched source and snippet. Confidence comes from the signal's
 * declared strength (combined as 1 - Π(1 - c)), never from a model.
 */
import type { Evidence, Technology } from "../schema.js";
import { now, uid, truncate } from "../util/index.js";

type Where = "header" | "html" | "scriptUrl" | "script" | "meta" | "cookie" | "css" | "cssUrl" | "url" | "global";

interface Signal {
  where: Where;
  /** header/meta/cookie name (lower-case) — for header/meta/cookie checks */
  key?: string;
  re: RegExp;
  c: number; // confidence contribution 0..1
  /** capture group index for a version number */
  v?: number;
  note?: string;
}

interface Rule {
  name: string;
  category: string;
  website?: string;
  signals: Signal[];
  implies?: string[];
}

const R = (name: string, category: string, signals: Signal[], extra: Partial<Rule> = {}): Rule => ({ name, category, signals, ...extra });

export const RULES: Rule[] = [
  // ---------- UI frameworks ----------
  R("React", "JavaScript framework", [
    { where: "script", re: /react\.(production|development)\.min\.js|__REACT_DEVTOOLS_GLOBAL_HOOK__|react-dom\.(production|development)/, c: 0.9 },
    { where: "script", re: /Symbol\.for\(["']react\.(element|transitional\.element|fragment)["']\)/, c: 0.85 },
    { where: "script", re: /\bReact(?:DOM)?\.version\s*=\s*["'](\d+\.\d+\.\d+)/, c: 0.9, v: 1 },
    { where: "html", re: /data-reactroot|data-reactid/, c: 0.8 },
    { where: "scriptUrl", re: /\/react(?:-dom)?(?:@|[-.])(\d+\.\d+\.\d+)?[^/]*\.js/i, c: 0.7, v: 1 },
  ], { website: "https://react.dev" }),
  R("Next.js", "Web framework", [
    { where: "html", re: /<script[^>]+id=["']__NEXT_DATA__["']/, c: 0.95, note: "__NEXT_DATA__ payload (pages router)" },
    { where: "scriptUrl", re: /\/_next\/static\//, c: 0.9, note: "/_next/static asset path" },
    { where: "html", re: /self\.__next_f\.push/, c: 0.95, note: "app-router flight data" },
    { where: "header", key: "x-powered-by", re: /Next\.js\s*([\d.]+)?/i, c: 0.95, v: 1 },
    { where: "header", key: "x-nextjs-cache", re: /.+/, c: 0.9 },
    { where: "header", key: "x-nextjs-prerender", re: /.+/, c: 0.9 },
    { where: "script", re: /window\.next\s*=\s*\{\s*version:\s*["']([\d.]+[^"']*)["']/, c: 0.95, v: 1 },
  ], { website: "https://nextjs.org", implies: ["React"] }),
  R("Remix", "Web framework", [
    { where: "html", re: /window\.__remixContext/, c: 0.95 },
    { where: "html", re: /window\.__reactRouterContext/, c: 0.85, note: "React Router framework mode" },
  ], { implies: ["React"] }),
  R("Gatsby", "Static site generator", [
    { where: "html", re: /id=["']___gatsby["']/, c: 0.95 },
    { where: "meta", key: "generator", re: /Gatsby\s*([\d.]+)?/i, c: 0.95, v: 1 },
  ], { implies: ["React"] }),
  R("Vue.js", "JavaScript framework", [
    { where: "html", re: /\sdata-v-[0-9a-f]{8}/, c: 0.85, note: "scoped-style attribute" },
    { where: "script", re: /__VUE__|__VUE_OPTIONS_API__|Vue\.version\s*=\s*["']([\d.]+)/, c: 0.85, v: 1 },
    { where: "html", re: /\sdata-v-app|<div[^>]+id=["']app["'][^>]*data-v-/, c: 0.7 },
    { where: "scriptUrl", re: /\/vue(?:@([\d.]+))?(?:\/dist)?\/vue(?:\.global|\.runtime)?(?:\.prod)?\.js/i, c: 0.8, v: 1 },
  ], { website: "https://vuejs.org" }),
  R("Nuxt", "Web framework", [
    { where: "html", re: /window\.__NUXT__|id=["']__nuxt["']|<script[^>]+id=["']__NUXT_DATA__["']/, c: 0.95 },
    { where: "scriptUrl", re: /\/_nuxt\//, c: 0.9 },
    { where: "meta", key: "generator", re: /Nuxt/i, c: 0.9 },
  ], { implies: ["Vue.js"] }),
  R("Angular", "JavaScript framework", [
    { where: "html", re: /\sng-version=["']([\d.]+)["']/, c: 0.95, v: 1 },
    { where: "html", re: /_nghost-[a-z0-9-]+|_ngcontent-[a-z0-9-]+/, c: 0.85 },
    { where: "script", re: /platformBrowserDynamic|ɵɵdefineComponent/, c: 0.85 },
  ]),
  R("AngularJS", "JavaScript framework", [
    { where: "html", re: /\sng-app[=\s>]/, c: 0.8 },
    { where: "script", re: /angular\.module\(/, c: 0.7 },
  ]),
  R("Svelte", "JavaScript framework", [
    { where: "html", re: /class=["'][^"']*\bsvelte-[a-z0-9]{5,8}\b/, c: 0.85 },
    { where: "script", re: /__svelte|svelte\/internal/, c: 0.75 },
  ]),
  R("SvelteKit", "Web framework", [
    { where: "html", re: /data-sveltekit-|__sveltekit_/, c: 0.95 },
    { where: "scriptUrl", re: /\/_app\/immutable\//, c: 0.85 },
  ], { implies: ["Svelte"] }),
  R("Astro", "Web framework", [
    { where: "html", re: /<astro-island|astro-[a-z0-9]{8}/, c: 0.9 },
    { where: "meta", key: "generator", re: /Astro\s*v?([\d.]+)?/i, c: 0.95, v: 1 },
    { where: "scriptUrl", re: /\/_astro\//, c: 0.85 },
  ]),
  R("SolidJS", "JavaScript framework", [{ where: "script", re: /\$\$typeof.*solid|_\$HY\b|window\._\$HY/, c: 0.75 }]),
  R("Qwik", "JavaScript framework", [{ where: "html", re: /q:container|q:version=["']([\d.]+)/, c: 0.95, v: 1 }]),
  R("Preact", "JavaScript framework", [{ where: "script", re: /__PREACT_DEVTOOLS__|preact\/(hooks|compat)/, c: 0.75 }]),
  R("Ember.js", "JavaScript framework", [{ where: "html", re: /class=["'][^"']*\bember-application\b|id=["']ember\d+/, c: 0.85 }]),
  R("jQuery", "JavaScript library", [
    { where: "scriptUrl", re: /jquery(?:[-.@]?(\d+\.\d+\.\d+))?(?:\.slim)?(?:\.min)?\.js/i, c: 0.85, v: 1 },
    { where: "script", re: /jQuery v(\d+\.\d+\.\d+)|jquery:\s*["'](\d+\.\d+\.\d+)/, c: 0.9, v: 1 },
  ]),
  R("Alpine.js", "JavaScript framework", [
    { where: "html", re: /\sx-data[=\s>]/, c: 0.8 },
    { where: "scriptUrl", re: /alpinejs/i, c: 0.85 },
  ]),
  R("htmx", "JavaScript library", [
    { where: "html", re: /\shx-(get|post|put|delete|patch|target|swap|trigger)=/, c: 0.85 },
    { where: "scriptUrl", re: /htmx(?:\.org)?(?:@([\d.]+))?/i, c: 0.85, v: 1 },
  ]),
  R("Lit", "JavaScript library", [{ where: "script", re: /litElementVersions|lit-html|reactiveElementVersions/, c: 0.8 }]),
  R("Stimulus / Hotwire", "JavaScript framework", [
    { where: "html", re: /\sdata-controller=|\sdata-turbo(?:-|=)/, c: 0.75 },
  ]),

  // ---------- Build tooling ----------
  R("Vite", "Bundler", [
    { where: "html", re: /\/@vite\/client|type=["']module["'][^>]+\/assets\/index-[\w-]{8}\.js/, c: 0.75 },
    { where: "script", re: /__vite__mapDeps|import\.meta\.hot|\/@vite\/client|__vitePreload/, c: 0.85 },
  ]),
  R("Webpack", "Bundler", [
    { where: "script", re: /webpackChunk[\w$]*|__webpack_require__|webpackJsonp/, c: 0.9 },
  ]),
  R("Turbopack", "Bundler", [{ where: "script", re: /TURBOPACK|__turbopack_/, c: 0.9 }]),
  R("Parcel", "Bundler", [{ where: "script", re: /parcelRequire[\w$]*/, c: 0.9 }]),
  R("esbuild", "Bundler", [{ where: "script", re: /__esm\s*=\s*\(|__toESM\s*=|__commonJS\s*=/, c: 0.55, note: "esbuild runtime helpers (also emitted by tools built on esbuild)" }]),
  R("Rollup", "Bundler", [{ where: "script", re: /Rollup|\/\*\* @license rollup/i, c: 0.4 }]),
  R("core-js", "JavaScript library", [{ where: "script", re: /core-js\/(?:modules|internals)|__core-js_shared__/, c: 0.8 }]),

  // ---------- Styling ----------
  R("Tailwind CSS", "CSS framework", [
    { where: "css", re: /--tw-(?:ring|shadow|translate|border-spacing|gradient)/, c: 0.9, note: "Tailwind CSS variables" },
    { where: "css", re: /tailwindcss v?([\d.]+)/i, c: 0.95, v: 1 },
    { where: "html", re: /class=["'][^"']*\b(?:flex|grid)\b[^"']*\b(?:px|py|mx|my|gap)-\d[^"']*\b(?:text|bg)-(?:slate|gray|zinc|neutral|stone|red|blue|indigo|emerald)-\d{2,3}\b/, c: 0.6, note: "utility class pattern" },
  ]),
  R("Bootstrap", "CSS framework", [
    { where: "cssUrl", re: /bootstrap(?:@|[-.])?(\d+\.\d+\.\d+)?[^/]*\.css/i, c: 0.85, v: 1 },
    { where: "css", re: /Bootstrap\s+v(\d+\.\d+\.\d+)/i, c: 0.95, v: 1 },
    { where: "scriptUrl", re: /bootstrap(?:\.bundle)?(?:\.min)?\.js/i, c: 0.8 },
  ]),
  R("Bulma", "CSS framework", [{ where: "css", re: /bulma\.io|Bulma v?([\d.]+)/i, c: 0.9, v: 1 }]),
  R("Foundation", "CSS framework", [{ where: "css", re: /Foundation for Sites/i, c: 0.9 }]),
  R("styled-components", "CSS-in-JS", [
    { where: "html", re: /data-styled(?:-version)?=|<style[^>]+data-styled/, c: 0.9 },
    { where: "script", re: /styled-components/, c: 0.6 },
  ]),
  R("Emotion", "CSS-in-JS", [{ where: "html", re: /data-emotion=|css-[a-z0-9]{6,7}-[A-Za-z]/, c: 0.75 }]),
  R("MUI", "UI library", [{ where: "html", re: /class=["'][^"']*\bMui[A-Z][A-Za-z]+-(?:root|container)/, c: 0.9 }], { implies: ["React", "Emotion"] }),
  R("Chakra UI", "UI library", [{ where: "html", re: /class=["'][^"']*\bchakra-[a-z]+|--chakra-/, c: 0.85 }]),
  R("Ant Design", "UI library", [{ where: "html", re: /class=["'][^"']*\bant-(?:btn|layout|menu|row|col)\b/, c: 0.85 }]),
  R("Radix UI", "UI library", [{ where: "html", re: /data-radix-[a-z-]+|data-state=["'](?:open|closed)["'][^>]+aria-controls=["']radix-/, c: 0.85 }]),
  R("Headless UI", "UI library", [{ where: "html", re: /id=["']headlessui-[a-z-]+-\d+/, c: 0.85 }]),
  R("Font Awesome", "Font library", [
    { where: "cssUrl", re: /font-?awesome/i, c: 0.85 },
    { where: "html", re: /class=["'][^"']*\bfa-(?:solid|regular|brands|[a-z]+-[a-z]+)\b/, c: 0.6 },
  ]),
  R("Google Fonts", "Font service", [{ where: "cssUrl", re: /fonts\.googleapis\.com|fonts\.gstatic\.com/, c: 0.95 }]),
  R("Adobe Fonts", "Font service", [{ where: "cssUrl", re: /use\.typekit\.net/, c: 0.95 }]),

  // ---------- State / data ----------
  R("Redux", "State management", [{ where: "script", re: /__REDUX_DEVTOOLS_EXTENSION(?:_COMPOSE)?__|@@redux\/INIT/, c: 0.85 }]),
  R("Zustand", "State management", [{ where: "script", re: /zustand|\[zustand persist middleware\]/, c: 0.65 }]),
  R("MobX", "State management", [{ where: "script", re: /__mobxGlobals|\[MobX\]/, c: 0.85 }]),
  R("TanStack Query", "Data fetching", [{ where: "script", re: /__REACT_QUERY_GLOBAL|QueryClientProvider|tanstack\/query/i, c: 0.75 }]),
  R("Apollo Client", "GraphQL client", [{ where: "script", re: /__APOLLO_CLIENT__|ApolloClient|__APOLLO_STATE__/, c: 0.85 }], { implies: ["GraphQL"] }),
  R("urql", "GraphQL client", [{ where: "script", re: /\burql\b|@urql\/core/, c: 0.6 }], { implies: ["GraphQL"] }),
  R("Relay", "GraphQL client", [{ where: "script", re: /RelayModernEnvironment|__RELAY_/, c: 0.8 }], { implies: ["GraphQL"] }),
  R("GraphQL", "API style", [
    { where: "script", re: /["'`][^"'`]*\/graphql["'`]|query\s+\w+\s*\([^)]*\$\w+:/, c: 0.7 },
  ]),
  R("React Router", "Routing", [{ where: "script", re: /__reactRouterVersion|useNavigate|createBrowserRouter/, c: 0.7 }], { implies: ["React"] }),
  R("Vue Router", "Routing", [{ where: "script", re: /vue-router|createWebHistory\(/, c: 0.7 }]),
  R("Socket.IO", "Realtime", [{ where: "script", re: /socket\.io|engine\.io/i, c: 0.75 }, { where: "scriptUrl", re: /socket\.io(?:\.min)?\.js/, c: 0.9 }]),
  R("WebSocket", "Browser API", [{ where: "script", re: /new\s+WebSocket\s*\(/, c: 0.9 }]),
  R("Server-Sent Events", "Browser API", [{ where: "script", re: /new\s+EventSource\s*\(/, c: 0.9 }]),
  R("Service Worker", "Browser API", [{ where: "script", re: /navigator\.serviceWorker\.register\s*\(/, c: 0.95 }]),
  R("WebAssembly", "Browser API", [{ where: "script", re: /WebAssembly\.(?:instantiate|instantiateStreaming|compile)\s*\(/, c: 0.95 }]),
  R("IndexedDB", "Browser storage", [{ where: "script", re: /indexedDB\.open\s*\(/, c: 0.9 }]),
  R("localStorage", "Browser storage", [{ where: "script", re: /localStorage\.(?:setItem|getItem)\s*\(/, c: 0.9 }]),
  R("sessionStorage", "Browser storage", [{ where: "script", re: /sessionStorage\.(?:setItem|getItem)\s*\(/, c: 0.9 }]),
  R("Web Workers", "Browser API", [{ where: "script", re: /new\s+(?:Shared)?Worker\s*\(/, c: 0.85 }]),
  R("WebGL", "Browser API", [{ where: "script", re: /getContext\(\s*["']webgl2?["']/, c: 0.9 }]),
  R("WebRTC", "Browser API", [{ where: "script", re: /new\s+RTCPeerConnection\s*\(/, c: 0.9 }]),

  // ---------- Visual / interaction libs ----------
  R("Three.js", "3D graphics", [{ where: "script", re: /THREE\.REVISION|three\.module\.js|__THREE__\s*=\s*["']?(\d+)/, c: 0.85, v: 1 }]),
  R("D3", "Data visualization", [{ where: "script", re: /d3-(?:selection|scale|shape)|\bd3\.select\(/, c: 0.75 }]),
  R("Chart.js", "Data visualization", [{ where: "script", re: /Chart\.js v?([\d.]+)|chartjs/i, c: 0.8, v: 1 }]),
  R("ECharts", "Data visualization", [{ where: "script", re: /echarts/i, c: 0.65 }]),
  R("React Flow", "Data visualization", [{ where: "html", re: /class=["'][^"']*\breact-flow__/, c: 0.9 }, { where: "script", re: /react-flow__|@xyflow\//, c: 0.75 }]),
  R("GSAP", "Animation", [{ where: "script", re: /GreenSock|gsap\.(?:to|from|timeline)\(|_gsScope/, c: 0.8 }]),
  R("Framer Motion", "Animation", [{ where: "script", re: /framer-motion|MotionConfigContext/, c: 0.7 }]),
  R("Lottie", "Animation", [{ where: "script", re: /lottie|bodymovin/i, c: 0.7 }]),
  R("Monaco Editor", "Code editor", [{ where: "script", re: /monaco-editor|monaco\.editor\.create/, c: 0.85 }]),
  R("CodeMirror", "Code editor", [{ where: "html", re: /class=["'][^"']*\bcm-editor\b|class=["'][^"']*\bCodeMirror\b/, c: 0.9 }]),
  R("Swiper", "UI library", [{ where: "html", re: /class=["'][^"']*\bswiper-(?:wrapper|slide)\b/, c: 0.85 }]),
  R("Lodash", "JavaScript library", [{ where: "script", re: /lodash(?:\.min)?\.js|\b_\.VERSION\s*=\s*["']([\d.]+)|var\s+VERSION\s*=\s*["'](4\.\d+\.\d+)["'][\s\S]{0,200}lodash/, c: 0.7, v: 1 }]),
  R("Moment.js", "JavaScript library", [{ where: "script", re: /moment\.version|hooks\.version\s*=\s*["']([\d.]+)["']/, c: 0.7, v: 1 }]),

  // ---------- Backend-as-a-service / auth ----------
  R("Firebase", "Backend platform", [
    { where: "script", re: /firebaseapp\.com|firebaseio\.com|firebase\/(?:app|auth|firestore)|initializeApp\(\s*\{[^}]*apiKey/, c: 0.85 },
    { where: "scriptUrl", re: /gstatic\.com\/firebasejs\/([\d.]+)/, c: 0.95, v: 1 },
  ]),
  R("Supabase", "Backend platform", [
    { where: "script", re: /[a-z0-9]{20}\.supabase\.co|@supabase\/supabase-js|supabase\.auth\./, c: 0.9 },
  ]),
  R("Auth0", "Authentication", [{ where: "script", re: /auth0\.com|@auth0\/|auth0-spa-js/, c: 0.85 }]),
  R("Clerk", "Authentication", [{ where: "script", re: /clerk\.(?:accounts\.dev|com)|@clerk\/|__clerk_/, c: 0.85 }, { where: "cookie", re: /^__(?:client_uat|session)\b/, c: 0.6 }]),
  R("NextAuth.js / Auth.js", "Authentication", [{ where: "cookie", re: /^(?:__Secure-)?(?:next-auth|authjs)\./, c: 0.9 }, { where: "script", re: /\/api\/auth\/(?:session|csrf|providers)/, c: 0.75 }]),
  R("Okta", "Authentication", [{ where: "script", re: /\.okta\.com|okta-auth-js/, c: 0.85 }]),
  R("Amazon Cognito", "Authentication", [{ where: "script", re: /cognito-idp\.[a-z0-9-]+\.amazonaws\.com|amazon-cognito-identity/, c: 0.85 }]),
  R("Google Sign-In", "Authentication", [{ where: "scriptUrl", re: /accounts\.google\.com\/gsi\/client/, c: 0.95 }]),

  // ---------- Analytics / monitoring ----------
  R("Google Analytics", "Analytics", [
    { where: "scriptUrl", re: /google-analytics\.com\/(?:analytics|ga)\.js|googletagmanager\.com\/gtag\/js\?id=G-/, c: 0.95 },
    { where: "script", re: /gtag\(\s*["']config["']\s*,\s*["'](?:G|UA)-/, c: 0.9 },
  ]),
  R("Google Tag Manager", "Tag manager", [{ where: "scriptUrl", re: /googletagmanager\.com\/gtm\.js/, c: 0.95 }, { where: "html", re: /googletagmanager\.com\/ns\.html\?id=GTM-/, c: 0.95 }]),
  R("Segment", "Analytics", [{ where: "scriptUrl", re: /cdn\.segment\.com|cdn\.segment\.io/, c: 0.95 }, { where: "script", re: /analytics\.load\(["'][A-Za-z0-9]{20,}["']\)|segment\.com\/analytics\.js/, c: 0.85 }]),
  R("PostHog", "Analytics", [{ where: "script", re: /posthog\.init\(|[a-z]+\.i\.posthog\.com|app\.posthog\.com|posthog-js/, c: 0.9 }]),
  R("Amplitude", "Analytics", [{ where: "script", re: /amplitude\.(?:getInstance|init)\(|cdn\.amplitude\.com|api2?\.amplitude\.com/, c: 0.9 }]),
  R("Mixpanel", "Analytics", [{ where: "script", re: /mixpanel\.init\(|cdn\.mxpnl\.com|api(?:-js)?\.mixpanel\.com/, c: 0.9 }]),
  R("Heap", "Analytics", [{ where: "script", re: /heap\.load\(|cdn\.heapanalytics\.com/, c: 0.9 }]),
  R("Hotjar", "Analytics", [{ where: "script", re: /static\.hotjar\.com|hjSiteSettings|_hjSettings/, c: 0.9 }]),
  R("Microsoft Clarity", "Analytics", [{ where: "script", re: /clarity\.ms\/tag/, c: 0.95 }]),
  R("Plausible", "Analytics", [{ where: "scriptUrl", re: /plausible\.io\/js/, c: 0.95 }]),
  R("Fathom", "Analytics", [{ where: "scriptUrl", re: /cdn\.usefathom\.com/, c: 0.95 }]),
  R("Vercel Analytics", "Analytics", [{ where: "scriptUrl", re: /\/_vercel\/insights\/script\.js|va\.vercel-scripts\.com/, c: 0.95 }]),
  R("Vercel Speed Insights", "Performance monitoring", [{ where: "scriptUrl", re: /\/_vercel\/speed-insights\/script\.js/, c: 0.95 }]),
  R("Sentry", "Error monitoring", [
    { where: "script", re: /[a-z0-9]+\.ingest\.(?:[a-z]+\.)?sentry\.io|Sentry\.init\(|__SENTRY__|sentry-trace/, c: 0.9 },
    { where: "scriptUrl", re: /browser\.sentry-cdn\.com\/([\d.]+)/, c: 0.95, v: 1 },
  ]),
  R("Datadog RUM", "Performance monitoring", [{ where: "script", re: /datadoghq-browser-agent|DD_RUM|browser-intake-datadoghq/, c: 0.9 }]),
  R("LogRocket", "Session replay", [{ where: "script", re: /cdn\.logrocket\.io|LogRocket\.init\(/, c: 0.9 }]),
  R("FullStory", "Session replay", [{ where: "script", re: /fullstory\.com\/s\/fs\.js|window\['_fs_namespace'\]/, c: 0.9 }]),
  R("New Relic", "Performance monitoring", [{ where: "script", re: /NREUM|js-agent\.newrelic\.com/, c: 0.9 }]),
  R("Bugsnag", "Error monitoring", [{ where: "script", re: /bugsnag/i, c: 0.75 }]),
  R("Meta Pixel", "Advertising", [{ where: "script", re: /connect\.facebook\.net\/[^/]+\/fbevents\.js|fbq\(\s*["']init["']/, c: 0.95 }]),
  R("LinkedIn Insight", "Advertising", [{ where: "script", re: /snap\.licdn\.com\/li\.lms-analytics|_linkedin_partner_id/, c: 0.95 }]),

  // ---------- Payments / commerce / support ----------
  R("Stripe", "Payments", [{ where: "scriptUrl", re: /js\.stripe\.com\/v(\d)/, c: 0.95, v: 1 }, { where: "script", re: /Stripe\(\s*["']pk_(?:live|test)_/, c: 0.9 }]),
  R("PayPal", "Payments", [{ where: "scriptUrl", re: /paypal\.com\/sdk\/js|paypalobjects\.com/, c: 0.95 }]),
  R("Paddle", "Payments", [{ where: "scriptUrl", re: /cdn\.paddle\.com/, c: 0.95 }]),
  R("Lemon Squeezy", "Payments", [{ where: "scriptUrl", re: /lemonsqueezy\.com\/js/, c: 0.95 }]),
  R("Shopify", "E-commerce", [{ where: "script", re: /cdn\.shopify\.com|Shopify\.theme/, c: 0.9 }, { where: "header", key: "x-shopid", re: /.+/, c: 0.95 }]),
  R("Intercom", "Customer support", [{ where: "script", re: /widget\.intercom\.io|intercomSettings/, c: 0.95 }]),
  R("Crisp", "Customer support", [{ where: "script", re: /client\.crisp\.chat/, c: 0.95 }]),
  R("Zendesk", "Customer support", [{ where: "script", re: /static\.zdassets\.com|zEmbed/, c: 0.9 }]),
  R("HubSpot", "Marketing automation", [{ where: "scriptUrl", re: /js\.hs-scripts\.com|js\.hsforms\.net/, c: 0.95 }]),
  R("Algolia", "Search", [{ where: "script", re: /algolia(?:net)?\.(?:com|net)|algoliasearch|DocSearch/i, c: 0.85 }]),
  R("Mapbox", "Maps", [{ where: "script", re: /api\.mapbox\.com|mapboxgl/, c: 0.9 }]),
  R("Google Maps", "Maps", [{ where: "scriptUrl", re: /maps\.googleapis\.com\/maps\/api\/js/, c: 0.95 }]),
  R("reCAPTCHA", "Bot protection", [{ where: "scriptUrl", re: /google\.com\/recaptcha|recaptcha\.net/, c: 0.95 }]),
  R("hCaptcha", "Bot protection", [{ where: "scriptUrl", re: /hcaptcha\.com\/1\/api\.js/, c: 0.95 }]),
  R("Cloudflare Turnstile", "Bot protection", [{ where: "scriptUrl", re: /challenges\.cloudflare\.com\/turnstile/, c: 0.95 }]),

  // ---------- CMS / site builders ----------
  R("WordPress", "CMS", [
    { where: "html", re: /\/wp-content\/|\/wp-includes\//, c: 0.9 },
    { where: "meta", key: "generator", re: /WordPress\s*([\d.]+)?/i, c: 0.95, v: 1 },
  ]),
  R("Drupal", "CMS", [{ where: "meta", key: "generator", re: /Drupal\s*(\d+)?/i, c: 0.95, v: 1 }, { where: "header", key: "x-drupal-cache", re: /.+/, c: 0.9 }]),
  R("Webflow", "Site builder", [{ where: "html", re: /data-wf-(?:page|site)=/, c: 0.95 }]),
  R("Wix", "Site builder", [{ where: "html", re: /static\.wixstatic\.com|wix-warmup-data/, c: 0.9 }]),
  R("Squarespace", "Site builder", [{ where: "html", re: /static1\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/, c: 0.95 }]),
  R("Framer", "Site builder", [{ where: "html", re: /framerusercontent\.com|data-framer-/, c: 0.9 }]),
  R("Ghost", "CMS", [{ where: "meta", key: "generator", re: /Ghost\s*([\d.]+)?/i, c: 0.95, v: 1 }]),
  R("Hugo", "Static site generator", [{ where: "meta", key: "generator", re: /Hugo\s*([\d.]+)?/i, c: 0.95, v: 1 }]),
  R("Jekyll", "Static site generator", [{ where: "meta", key: "generator", re: /Jekyll\s*v?([\d.]+)?/i, c: 0.95, v: 1 }]),
  R("Docusaurus", "Static site generator", [{ where: "meta", key: "generator", re: /Docusaurus\s*v?([\d.]+)?/i, c: 0.95, v: 1 }]),
  R("VitePress", "Static site generator", [{ where: "meta", key: "generator", re: /VitePress\s*v?([\d.]+)?/i, c: 0.95, v: 1 }]),
  R("Mintlify", "Documentation platform", [{ where: "html", re: /mintlify/i, c: 0.7 }]),
  R("Contentful", "Headless CMS", [{ where: "script", re: /ctfassets\.net|cdn\.contentful\.com/, c: 0.9 }]),
  R("Sanity", "Headless CMS", [{ where: "script", re: /cdn\.sanity\.io|[a-z0-9]{8}\.api\.sanity\.io/, c: 0.9 }]),

  // ---------- Hosting / CDN / server ----------
  R("Vercel", "Hosting", [
    { where: "header", key: "x-vercel-id", re: /.+/, c: 0.95 },
    { where: "header", key: "server", re: /^Vercel$/i, c: 0.95 },
    { where: "header", key: "x-vercel-cache", re: /.+/, c: 0.95 },
  ]),
  R("Netlify", "Hosting", [{ where: "header", key: "server", re: /Netlify/i, c: 0.95 }, { where: "header", key: "x-nf-request-id", re: /.+/, c: 0.95 }]),
  R("Cloudflare", "CDN", [{ where: "header", key: "server", re: /cloudflare/i, c: 0.95 }, { where: "header", key: "cf-ray", re: /.+/, c: 0.95 }]),
  R("Cloudflare Pages", "Hosting", [{ where: "url", re: /\.pages\.dev\//, c: 0.95 }]),
  R("Amazon CloudFront", "CDN", [{ where: "header", key: "x-amz-cf-id", re: /.+/, c: 0.95 }, { where: "header", key: "via", re: /CloudFront/i, c: 0.95 }]),
  R("Amazon S3", "Hosting", [{ where: "header", key: "server", re: /AmazonS3/i, c: 0.95 }]),
  R("Fastly", "CDN", [{ where: "header", key: "x-served-by", re: /cache-[a-z]{3}/i, c: 0.8 }, { where: "header", key: "via", re: /varnish/i, c: 0.5 }, { where: "header", key: "x-fastly-request-id", re: /.+/, c: 0.95 }]),
  R("Akamai", "CDN", [{ where: "header", key: "x-akamai-transformed", re: /.+/, c: 0.9 }, { where: "header", key: "server", re: /AkamaiGHost/i, c: 0.95 }]),
  R("GitHub Pages", "Hosting", [{ where: "header", key: "server", re: /GitHub\.com/i, c: 0.95 }]),
  R("Fly.io", "Hosting", [{ where: "header", key: "fly-request-id", re: /.+/, c: 0.95 }]),
  R("Render", "Hosting", [{ where: "header", key: "x-render-origin-server", re: /.+/, c: 0.95 }]),
  R("Heroku", "Hosting", [{ where: "header", key: "via", re: /vegur/i, c: 0.9 }]),
  R("Google Cloud", "Cloud platform", [{ where: "header", key: "via", re: /1\.1 google/i, c: 0.7 }, { where: "header", key: "server", re: /^(?:gws|Google Frontend|ESF)$/i, c: 0.8 }]),
  R("Azure", "Cloud platform", [{ where: "header", key: "x-azure-ref", re: /.+/, c: 0.95 }, { where: "header", key: "x-ms-request-id", re: /.+/, c: 0.6 }]),
  R("Nginx", "Web server", [{ where: "header", key: "server", re: /nginx(?:\/([\d.]+))?/i, c: 0.95, v: 1 }]),
  R("Apache HTTP Server", "Web server", [{ where: "header", key: "server", re: /Apache(?:\/([\d.]+))?/i, c: 0.95, v: 1 }]),
  R("Caddy", "Web server", [{ where: "header", key: "server", re: /Caddy/i, c: 0.95 }]),
  R("Microsoft IIS", "Web server", [{ where: "header", key: "server", re: /Microsoft-IIS(?:\/([\d.]+))?/i, c: 0.95, v: 1 }]),
  R("Express", "Web framework", [{ where: "header", key: "x-powered-by", re: /^Express$/i, c: 0.95 }], { implies: ["Node.js"] }),
  R("Node.js", "Runtime", [{ where: "header", key: "x-powered-by", re: /node/i, c: 0.6 }]),
  R("PHP", "Language", [{ where: "header", key: "x-powered-by", re: /PHP(?:\/([\d.]+))?/i, c: 0.95, v: 1 }, { where: "cookie", re: /^PHPSESSID$/, c: 0.85 }]),
  R("ASP.NET", "Web framework", [{ where: "header", key: "x-aspnet-version", re: /([\d.]+)/, c: 0.95, v: 1 }, { where: "header", key: "x-powered-by", re: /ASP\.NET/i, c: 0.95 }, { where: "cookie", re: /^ASP\.NET_SessionId$/, c: 0.85 }]),
  R("Ruby on Rails", "Web framework", [{ where: "html", re: /<meta name=["']csrf-param["'] content=["']authenticity_token/, c: 0.85 }, { where: "cookie", re: /^_[a-z_]+_session$/, c: 0.4 }]),
  R("Django", "Web framework", [{ where: "cookie", re: /^csrftoken$/, c: 0.6 }, { where: "html", re: /name=["']csrfmiddlewaretoken["']/, c: 0.9 }]),
  R("Laravel", "Web framework", [{ where: "cookie", re: /^laravel_session$|^XSRF-TOKEN$/, c: 0.8 }]),
  R("HSTS", "Security header", [{ where: "header", key: "strict-transport-security", re: /max-age=(\d+)/i, c: 1 }]),
  R("Content Security Policy", "Security header", [{ where: "header", key: "content-security-policy", re: /.+/, c: 1 }]),
  R("HTTP/3", "Protocol", [{ where: "header", key: "alt-svc", re: /h3=/, c: 0.95 }]),
  R("PWA", "Browser API", [{ where: "html", re: /<link[^>]+rel=["']manifest["']/, c: 0.6, note: "Web app manifest" }]),
];

export interface FingerprintInput {
  url: string;
  headers: Record<string, string>;
  html: string;
  scriptUrls: string[];
  scripts: { url: string; content: string }[];
  css: { url: string; content: string }[];
  cssUrls: string[];
  meta: Record<string, string>;
  cookies: string[]; // cookie NAMES only
}

/** Run every rule against the input. Returns technologies + their evidence. */
export function fingerprint(input: FingerprintInput): { technologies: Technology[]; evidence: Evidence[] } {
  const evidence: Evidence[] = [];
  const found = new Map<string, { rule: Rule; conf: number; version?: string; ev: string[] }>();

  const record = (rule: Rule, s: Signal, source: string, match: RegExpMatchArray, haystack: string) => {
    const idx = match.index ?? 0;
    const snippet = truncate(haystack.slice(Math.max(0, idx - 40), idx + match[0].length + 40).replace(/\s+/g, " "), 220);
    const e: Evidence = {
      id: uid("ev"),
      kind: "observed",
      method: `fingerprint:${s.where}`,
      source,
      timestamp: now(),
      confidence: s.c,
      summary: `${rule.name}: ${s.note ?? `matched ${s.where}${s.key ? ` "${s.key}"` : ""} pattern`}`,
      snippet,
      related: [`tech:${rule.name}`],
    };
    evidence.push(e);
    const cur = found.get(rule.name) ?? { rule, conf: 0, ev: [] };
    cur.conf = 1 - (1 - cur.conf) * (1 - s.c);
    const ver = s.v !== undefined ? match[s.v] : undefined;
    if (ver && !cur.version) cur.version = ver;
    cur.ev.push(e.id);
    found.set(rule.name, cur);
  };

  const scriptsJoined = input.scripts.map((s) => ({ url: s.url, content: s.content }));
  for (const rule of RULES) {
    for (const s of rule.signals) {
      let hit = false;
      const test = (hay: string, source: string) => {
        if (hit) return;
        const m = hay.match(s.re);
        if (m) {
          hit = true;
          record(rule, s, source, m, hay);
        }
      };
      switch (s.where) {
        case "header":
          if (s.key && input.headers[s.key] !== undefined) test(input.headers[s.key]!, `${input.url} [header ${s.key}]`);
          break;
        case "meta":
          if (s.key && input.meta[s.key] !== undefined) test(input.meta[s.key]!, `${input.url} [meta ${s.key}]`);
          break;
        case "html":
          test(input.html, input.url);
          break;
        case "url":
          test(input.url, input.url);
          break;
        case "scriptUrl":
          for (const u of input.scriptUrls) test(u, u);
          break;
        case "cssUrl":
          for (const u of input.cssUrls) test(u, u);
          break;
        case "script":
          for (const sc of scriptsJoined) test(sc.content, sc.url);
          break;
        case "css":
          for (const c of input.css) test(c.content, c.url);
          break;
        case "cookie":
          for (const c of input.cookies) test(c, `${input.url} [cookie name]`);
          break;
        case "global":
          break;
      }
    }
  }

  // Implications are recorded as inferred evidence, with lower confidence.
  for (const { rule, conf } of [...found.values()]) {
    for (const imp of rule.implies ?? []) {
      if (found.has(imp)) continue;
      const target = RULES.find((r) => r.name === imp);
      if (!target) continue;
      const e: Evidence = {
        id: uid("ev"),
        kind: "inferred",
        method: "fingerprint:implies",
        source: input.url,
        timestamp: now(),
        confidence: conf * 0.9,
        summary: `${imp} implied by ${rule.name}`,
        related: [`tech:${imp}`],
      };
      evidence.push(e);
      found.set(imp, { rule: target, conf: conf * 0.9, ev: [e.id] });
    }
  }

  const technologies: Technology[] = [...found.values()]
    .map(({ rule, conf, version, ev }) => ({
      name: rule.name,
      category: rule.category,
      version,
      confidence: Math.round(conf * 100) / 100,
      evidence: ev,
      website: rule.website,
    }))
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  return { technologies, evidence };
}

/** Merge per-page fingerprint results. */
export function mergeTechnologies(lists: Technology[][]): Technology[] {
  const m = new Map<string, Technology>();
  for (const list of lists)
    for (const t of list) {
      const cur = m.get(t.name);
      if (!cur) m.set(t.name, { ...t, evidence: [...t.evidence] });
      else {
        cur.confidence = Math.round((1 - (1 - cur.confidence) * (1 - t.confidence)) * 100) / 100;
        cur.evidence.push(...t.evidence);
        cur.version ??= t.version;
      }
    }
  return [...m.values()].sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
}
