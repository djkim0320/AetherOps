export function sourceAwareWorkerUrl(sourceName: string, compiledName = sourceName): URL {
  const sourceMode = import.meta.url.endsWith(".ts");
  return new URL(sourceMode ? `./${sourceName}.ts` : `./${compiledName}.js`, import.meta.url);
}

export function sourceAwareWorkerExecArgv(): string[] {
  const inherited = process.execArgv.filter((argument) => !argument.startsWith("--input-type"));
  if (!import.meta.url.endsWith(".ts")) return inherited;
  return [...inherited, "--experimental-transform-types", "--no-warnings", "--import", new URL("./registerTypescriptSourceLoader.mjs", import.meta.url).href];
}
