/**
 * robots.txt parser implementing RFC 9309 group matching with longest-match
 * precedence (Allow wins ties), `*` wildcards and `$` anchors.
 */
export interface RobotsRules {
  allow(path: string): boolean;
  crawlDelay?: number;
  sitemaps: string[];
}

interface Rule {
  allow: boolean;
  pattern: string;
  re: RegExp;
}

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

export function parseRobots(txt: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  const groups: { agents: string[]; rules: Rule[]; delay?: number }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[]; delay?: number } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") {
      sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (key === "disallow" && value === "") continue; // empty disallow = allow all
      current.rules.push({ allow: key === "allow", pattern: value, re: toRegex(value) });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (!Number.isNaN(n)) current.delay = n;
    }
  }
  // Pick the most specific group: exact product token match, else "*".
  const token = ua.split(/[\/\s]/)[0] ?? ua;
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const delay = chosen.find((g) => g.delay !== undefined)?.delay;
  return {
    sitemaps,
    crawlDelay: delay,
    allow(path: string) {
      if (path === "/robots.txt") return true;
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}
