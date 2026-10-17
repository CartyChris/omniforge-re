import { probeHandler } from "../handlers.js";
import { nodeAdapter } from "./adapter.js";
export default nodeAdapter((req) => probeHandler(req, { mode: "hosted" }));
