/**
 * Stand-in for `@codesandbox/nodebox`, aliased in vite.config.ts. Nodebox is licensed under the Sustainable Use License (internal-business or
 * non-commercial use only), so it is not shipped. Sandpack only reaches it for "node" templates, which this app never selects
 * (see planSandpack in @omniforge/core); if one is ever requested it fails with a clear message instead of loading a third-party runtime.
 */
export const INJECT_MESSAGE_TYPE = "INJECT_AND_INVOKE";
export const PREVIEW_LOADED_MESSAGE_TYPE = "PREVIEW_LOADED";
export class Nodebox {
  constructor(..._args: unknown[]) { throw new Error("The Nodebox runtime is not included in OmniForge RE (its licence does not allow this use). Run your dev server from the Terminal tab for full-stack previews."); }
}
