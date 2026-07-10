import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.endsWith(".js") || !context.parentURL?.startsWith("file:")) throw error;
    const sourceUrl = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (!existsSync(fileURLToPath(sourceUrl))) throw error;
    return nextResolve(sourceUrl.href, context);
  }
}
