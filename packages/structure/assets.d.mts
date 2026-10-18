export const RUNTIME_FILE: string;
export const GRAMMAR_FILES: Record<string, string>;
export const ASSET_FILES: string[];
export function findPackage(name: string, start: string): string | undefined;
export function assembleAssets(start: string): string;
