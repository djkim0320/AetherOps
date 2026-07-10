import { createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";

interface ShellPreferencesContextValue {
  railCollapsed: boolean;
  setRailCollapsed: (collapsed: boolean) => void;
  toggleRail: () => void;
}

const shellPreferencesStorageKey = "aetherops.shellPreferences:v1";
const ShellPreferencesContext = createContext<ShellPreferencesContextValue | null>(null);

function readInitialRailCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const stored = window.localStorage.getItem(shellPreferencesStorageKey);
    return stored === "true";
  } catch {
    return false;
  }
}

export function ShellPreferencesProvider({ children }: { children: ReactNode }): ReactElement {
  const [railCollapsed, setRailCollapsedState] = useState(readInitialRailCollapsed);

  useEffect(() => {
    try {
      window.localStorage.setItem(shellPreferencesStorageKey, String(railCollapsed));
    } catch {
      return;
    }
  }, [railCollapsed]);

  const value: ShellPreferencesContextValue = {
    railCollapsed,
    setRailCollapsed: setRailCollapsedState,
    toggleRail: () => setRailCollapsedState((current) => !current)
  };

  return <ShellPreferencesContext.Provider value={value}>{children}</ShellPreferencesContext.Provider>;
}

export function useShellPreferences(): ShellPreferencesContextValue {
  const context = useContext(ShellPreferencesContext);
  if (!context) {
    throw new Error("useShellPreferences must be used within ShellPreferencesProvider.");
  }
  return context;
}
