/**
 * JavaScript parser adapter: oxc (Rust, MIT) first, acorn as automatic fallback.
 *
 * oxc is loaded lazily (native binding in Node/Bun, WASM via the package's
 * `browser` field). Until `loadOxc()` has resolved, or whenever oxc is missing,
 * throws, or reports a syntax error, acorn parses the code exactly as before.
 * Both paths return an ESTree Program that acorn-walk can traverse.
 */
import { parse as acornParse, type Node } from "acorn";

export type ParserName = "oxc" | "acorn";
export interface ParsedProgram {
  ast: Node;
  parser: ParserName;
}

type OxcParseSync = (filename: string, code: string, opts: Record<string, unknown>) => { program: any; errors: { message: string }[] };

let oxcParseSync: OxcParseSync | null = null;
let oxcLoad: Promise<boolean> | null = null;
let forceAcorn = typeof process !== "undefined" && process.env?.OMNIFORGE_PARSER === "acorn";

/** Force the acorn path (tests, debugging). */
export function setForceAcorn(v: boolean): void {
  forceAcorn = v;
}

export function oxcAvailable(): boolean {
  return !!oxcParseSync && !forceAcorn;
}

/** Load oxc once. Resolves false (and acorn stays in use) when it cannot load. */
export function loadOxc(): Promise<boolean> {
  oxcLoad ??= (async () => {
    try {
      const spec = "oxc-parser";
      const mod: any = await import(/* @vite-ignore */ spec);
      const fn = mod.parseSync ?? mod.default?.parseSync;
      if (typeof fn !== "function") return false;
      oxcParseSync = fn;
      return true;
    } catch {
      return false;
    }
  })();
  return oxcLoad;
}

function viaOxc(code: string, sourceType: "module" | "script"): Node {
  const r = oxcParseSync!("input.js", code, { sourceType, lang: "js", preserveParens: false });
  if (r.errors?.length) throw new Error(r.errors[0]!.message);
  return r.program as Node;
}

function viaAcorn(code: string, sourceType: "module" | "script"): Node {
  return acornParse(code, {
    ecmaVersion: "latest",
    sourceType,
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
  });
}

/** Parse with oxc when available, else (or on any oxc error) with acorn. Throws only if acorn also fails. */
export function parseProgram(code: string, opts: { sourceType: "module" | "script" }): ParsedProgram {
  if (oxcAvailable()) {
    try {
      return { ast: viaOxc(code, opts.sourceType), parser: "oxc" };
    } catch {
      /* fall through to acorn */
    }
  }
  return { ast: viaAcorn(code, opts.sourceType), parser: "acorn" };
}

// Start loading eagerly; failure is silent and leaves acorn in charge.
void loadOxc();
