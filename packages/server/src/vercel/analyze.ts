import { analyzeHandler } from "../handlers.js";
import { nodeAdapter } from "./adapter.js";
export default nodeAdapter((req) => analyzeHandler(req, { mode: "hosted" }));
