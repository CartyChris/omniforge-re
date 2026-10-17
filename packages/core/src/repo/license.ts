/**
 * Licence detection and the "rights checkpoint".
 *
 * Re-creating a repository is only useful if you know what you may do with the
 * result, so every rip reports the licence, what it requires, and whether the
 * combination of repos is compatible. Repos with no licence (or a proprietary
 * one) are "all rights reserved" by default: the user must attest to having
 * the right before anything is copied.
 */
export type LicenseClass = "permissive" | "weak-copyleft" | "strong-copyleft" | "network-copyleft" | "public-domain" | "proprietary" | "none" | "unknown";

export interface LicenseInfo {
  spdx: string; // SPDX id, "NONE" or "UNKNOWN"
  class: LicenseClass;
  source: string; // where we found it
  evidence?: string;
}

interface Sig { spdx: string; class: LicenseClass; test: RegExp[] }

const SIGS: Sig[] = [
  { spdx: "AGPL-3.0", class: "network-copyleft", test: [/GNU AFFERO GENERAL PUBLIC LICENSE/i, /Version 3/i] },
  { spdx: "LGPL-3.0", class: "weak-copyleft", test: [/GNU LESSER GENERAL PUBLIC LICENSE/i, /Version 3/i] },
  { spdx: "LGPL-2.1", class: "weak-copyleft", test: [/GNU LESSER GENERAL PUBLIC LICENSE/i, /Version 2\.1/i] },
  { spdx: "GPL-3.0", class: "strong-copyleft", test: [/GNU GENERAL PUBLIC LICENSE/i, /Version 3/i] },
  { spdx: "GPL-2.0", class: "strong-copyleft", test: [/GNU GENERAL PUBLIC LICENSE/i, /Version 2/i] },
  { spdx: "MPL-2.0", class: "weak-copyleft", test: [/Mozilla Public License,? Version 2\.0/i] },
  { spdx: "EPL-2.0", class: "weak-copyleft", test: [/Eclipse Public License - v 2\.0/i] },
  { spdx: "Apache-2.0", class: "permissive", test: [/Apache License/i, /Version 2\.0/i] },
  { spdx: "BSL-1.0", class: "permissive", test: [/Boost Software License/i] },
  { spdx: "Unlicense", class: "public-domain", test: [/This is free and unencumbered software released into the public domain/i] },
  { spdx: "CC0-1.0", class: "public-domain", test: [/CC0 1\.0 Universal/i] },
  { spdx: "0BSD", class: "permissive", test: [/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted\.(?![\s\S]{0,40}provided that the above copyright)/i] },
  { spdx: "ISC", class: "permissive", test: [/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice/i] },
  { spdx: "MIT", class: "permissive", test: [/Permission is hereby granted, free of charge, to any person obtaining a copy/i] },
  { spdx: "BSD-3-Clause", class: "permissive", test: [/Redistribution and use in source and binary forms/i, /Neither the name of/i] },
  { spdx: "BSD-2-Clause", class: "permissive", test: [/Redistribution and use in source and binary forms/i] },
  { spdx: "Zlib", class: "permissive", test: [/This software is provided 'as-is', without any express or implied warranty/i] },
  { spdx: "CC-BY-4.0", class: "permissive", test: [/Creative Commons Attribution 4\.0/i] },
  { spdx: "CC-BY-SA-4.0", class: "strong-copyleft", test: [/Creative Commons Attribution-ShareAlike 4\.0/i] },
  { spdx: "CC-BY-NC-4.0", class: "proprietary", test: [/Attribution-NonCommercial/i] },
  { spdx: "SSPL-1.0", class: "network-copyleft", test: [/Server Side Public License/i] },
  { spdx: "BUSL-1.1", class: "proprietary", test: [/Business Source License/i] },
];

const CLASS_BY_SPDX = new Map(SIGS.map((s) => [s.spdx, s.class]));

export function classifySpdx(id: string): LicenseClass {
  const norm = id.replace(/\+$/, "").replace(/-only$|-or-later$/i, "");
  for (const [k, c] of CLASS_BY_SPDX) if (k.toLowerCase() === id.toLowerCase() || k.toLowerCase() === norm.toLowerCase()) return c;
  if (/^(?:UNLICENSED|SEE LICENSE|PROPRIETARY)/i.test(id)) return "proprietary";
  if (/^NONE$/i.test(id)) return "none";
  if (/\bOR\b/i.test(id)) return "unknown"; // compound expressions are resolved by the caller
  return "unknown";
}

export function detectLicenseText(text: string): { spdx: string; class: LicenseClass } | null {
  const t = text.slice(0, 20_000);
  for (const s of SIGS) if (s.test.every((re) => re.test(t))) return { spdx: s.spdx, class: s.class };
  return null;
}

const LICENSE_FILE = /(?:^|\/)(?:LICEN[CS]E|COPYING|UNLICENSE)(?:[-.][\w.-]+)?$/i;

/** Detect a repo's licence from files + manifests. Never guesses: falls back to NONE/UNKNOWN. */
export function detectLicense(files: { path: string; content?: string }[], hint?: { spdx?: string | null }): LicenseInfo[] {
  const found: LicenseInfo[] = [];
  const seen = new Set<string>();
  const push = (l: LicenseInfo) => { const k = `${l.spdx}@${l.source}`; if (!seen.has(k)) { seen.add(k); found.push(l); } };
  for (const f of files) {
    if (f.path.split("/").length > 3 || !LICENSE_FILE.test(f.path) || !f.content) continue;
    const d = detectLicenseText(f.content);
    if (d) push({ ...d, source: f.path, evidence: f.content.split("\n").find((l) => l.trim())?.trim().slice(0, 80) });
    else push({ spdx: "UNKNOWN", class: "unknown", source: f.path, evidence: "licence file present but not a recognised licence text" });
  }
  const pkg = files.find((f) => f.path === "package.json" && f.content);
  if (pkg) {
    try {
      const j = JSON.parse(pkg.content!);
      const lic = typeof j.license === "string" ? j.license : j.license?.type;
      if (lic) push({ spdx: lic, class: classifySpdx(lic), source: "package.json" });
    } catch { /* ignore */ }
  }
  const cargo = files.find((f) => f.path === "Cargo.toml" && f.content);
  const cm = cargo?.content?.match(/^license\s*=\s*"([^"]+)"/m);
  if (cm) push({ spdx: cm[1]!, class: classifySpdx(cm[1]!), source: "Cargo.toml" });
  const py = files.find((f) => f.path === "pyproject.toml" && f.content);
  const pm = py?.content?.match(/^license\s*=\s*(?:\{\s*(?:text|file)\s*=\s*)?"([^"]+)"/m);
  if (pm) push({ spdx: pm[1]!, class: classifySpdx(pm[1]!), source: "pyproject.toml" });
  if (hint?.spdx && hint.spdx !== "NOASSERTION") push({ spdx: hint.spdx, class: classifySpdx(hint.spdx), source: "repository host metadata" });
  if (!found.length) found.push({ spdx: "NONE", class: "none", source: "no licence file or metadata found" });
  return found;
}

/** The effective licence: the most restrictive of those detected (conservative). */
const RESTRICT: LicenseClass[] = ["public-domain", "permissive", "weak-copyleft", "strong-copyleft", "network-copyleft", "unknown", "proprietary", "none"];
export function effective(licenses: LicenseInfo[]): LicenseInfo {
  // A repo that has a recognised licence file beats a bare metadata hint; otherwise take the most restrictive.
  const recognised = licenses.filter((l) => l.class !== "unknown" && l.class !== "none");
  const pool = recognised.length ? recognised : licenses;
  return [...pool].sort((a, b) => RESTRICT.indexOf(b.class) - RESTRICT.indexOf(a.class))[0]!;
}

export interface Assessment {
  level: "ok" | "attribution" | "copyleft" | "attestation-required";
  messages: string[];
  /** The user must tick "I own this or have permission" before anything is copied. */
  requiresAttestation: boolean;
  perRepo: { repo: string; license: LicenseInfo; obligations: string[] }[];
  conflicts: string[];
  requiredFiles: string[];
}

const OBLIGATIONS: Record<LicenseClass, string[]> = {
  "public-domain": ["No conditions (attribution still recommended)."],
  permissive: ["Keep the copyright notice and licence text with any copy or substantial portion (an ATTRIBUTION file is generated for you)."],
  "weak-copyleft": ["Keep notices. Modifications to the licensed files themselves must be shared under the same licence; linking from a larger work is generally allowed."],
  "strong-copyleft": ["Keep notices. A work that copies or is derived from this code must be released under the same licence (source available) when distributed."],
  "network-copyleft": ["Keep notices. Derived work must be released under the same licence, INCLUDING when users only interact with it over a network (e.g. a hosted web app)."],
  proprietary: ["Not open-source. Copying or adapting is not permitted without the owner's permission."],
  none: ["No licence is published: by default all rights are reserved and you have no permission to copy or adapt it unless you own it or have the owner's permission."],
  unknown: ["The licence could not be identified automatically. Read the licence file before copying or adapting."],
};

export type RipPurpose = "clone" | "port" | "mesh";

export function assessRip(repos: { repo: string; licenses: LicenseInfo[] }[], purpose: RipPurpose): Assessment {
  const perRepo = repos.map((r) => { const l = effective(r.licenses); return { repo: r.repo, license: l, obligations: OBLIGATIONS[l.class] }; });
  const classes = perRepo.map((p) => p.license.class);
  const messages: string[] = [];
  const conflicts: string[] = [];
  const requiresAttestation = classes.some((c) => c === "none" || c === "proprietary" || c === "unknown");
  for (const p of perRepo) if (p.license.class === "none" || p.license.class === "proprietary" || p.license.class === "unknown") messages.push(`${p.repo}: ${p.license.spdx} — ${OBLIGATIONS[p.license.class][0]}`);
  const spdx = perRepo.map((p) => p.license.spdx);
  const has = (c: LicenseClass) => classes.includes(c);
  if (has("strong-copyleft") || has("network-copyleft")) {
    const names = perRepo.filter((p) => p.license.class === "strong-copyleft" || p.license.class === "network-copyleft").map((p) => `${p.repo} (${p.license.spdx})`).join(", ");
    messages.push(`Copyleft code involved: ${names}. ${purpose === "clone" ? "A verbatim copy must keep the same licence if you distribute it." : "Anything derived from it must be released under the same licence when distributed" + (has("network-copyleft") ? " or hosted for others (AGPL/SSPL network clause)." : ".")}`);
  }
  if (purpose !== "clone" && perRepo.length > 1) {
    const gpl2 = spdx.some((s) => /^GPL-2\.0/.test(s));
    const gpl3 = spdx.some((s) => /^(?:GPL-3|AGPL-3|LGPL-3)/.test(s));
    if (gpl2 && gpl3) conflicts.push("GPL-2.0-only code cannot be combined with GPL-3.0/AGPL-3.0 code in one work.");
    if (spdx.includes("Apache-2.0") && gpl2) conflicts.push("Apache-2.0 code is incompatible with GPL-2.0-only; combining them in one work is not permitted.");
    if (spdx.some((s) => /^AGPL/.test(s)) && spdx.some((s) => /^GPL-2\.0/.test(s))) conflicts.push("AGPL-3.0 and GPL-2.0-only are incompatible.");
    if (classes.includes("proprietary") && (has("strong-copyleft") || has("network-copyleft"))) conflicts.push("A proprietary component cannot be combined with copyleft code.");
    if (has("strong-copyleft") || has("network-copyleft")) messages.push("The combined work will be a derivative of the copyleft component(s); plan to license the whole under a compatible copyleft licence.");
  }
  const level: Assessment["level"] = requiresAttestation ? "attestation-required" : has("strong-copyleft") || has("network-copyleft") || has("weak-copyleft") ? "copyleft" : classes.every((c) => c === "public-domain") ? "ok" : "attribution";
  if (level === "attribution") messages.push("Permissive licence(s): free to copy and adapt. Keep the licence notices (generated automatically).");
  return { level, messages, requiresAttestation, perRepo, conflicts, requiredFiles: ["ATTRIBUTION.md", "licenses/"] };
}

export class RightsError extends Error {}

/** Throws unless the user attested (when required). Conflicts are reported but not blocking: they inform the license choice. */
export function assertCanRip(a: Assessment, attested: boolean) {
  if (a.requiresAttestation && !attested) throw new RightsError("This repository has no usable open-source licence. Confirm that you own it or have the owner's permission to copy or adapt it, then try again.");
}
