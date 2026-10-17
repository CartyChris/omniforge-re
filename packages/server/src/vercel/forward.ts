import { forwardHandler } from "../handlers.js";
import { nodeAdapter } from "./adapter.js";
export default nodeAdapter((req) => forwardHandler(req, { mode: "hosted" }));
