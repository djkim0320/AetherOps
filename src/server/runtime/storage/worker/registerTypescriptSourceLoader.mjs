import { register } from "node:module";

register(new URL("./typescriptSourceLoader.mjs", import.meta.url));
