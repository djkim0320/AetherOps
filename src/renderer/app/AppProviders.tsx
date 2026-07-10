import { type ReactElement, type ReactNode } from "react";
import { QueryProvider } from "./QueryProvider.js";
import { ShellPreferencesProvider } from "./ShellPreferencesProvider.js";
import { ThemeProvider } from "./ThemeProvider.js";

export function AppProviders({ children }: { children: ReactNode }): ReactElement {
  return (
    <QueryProvider>
      <ThemeProvider>
        <ShellPreferencesProvider>{children}</ShellPreferencesProvider>
      </ThemeProvider>
    </QueryProvider>
  );
}
