import { repoFilesHandler } from "../handlers.js";
import { nodeAdapter } from "./adapter.js";
export default nodeAdapter((req) => repoFilesHandler(req, { mode: "hosted" }));
