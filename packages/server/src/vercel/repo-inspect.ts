import { repoInspectHandler } from "../handlers.js";
import { nodeAdapter } from "./adapter.js";
export default nodeAdapter((req) => repoInspectHandler(req, { mode: "hosted" }));
