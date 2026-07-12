import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { ko } from "../platform/i18n.js";

export const MIN_DESKTOP_WIDTH = 1280;
export const MIN_DESKTOP_HEIGHT = 720;

const desktopMediaQuery = `(min-width: ${MIN_DESKTOP_WIDTH}px) and (min-height: ${MIN_DESKTOP_HEIGHT}px)`;

function isDesktopViewport(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(desktopMediaQuery).matches;
  }
  return window.innerWidth >= MIN_DESKTOP_WIDTH && window.innerHeight >= MIN_DESKTOP_HEIGHT;
}

export function DesktopRequiredBoundary({ children }: { children: ReactNode }): ReactElement {
  const [isSupported, setIsSupported] = useState(isDesktopViewport);

  useEffect(() => {
    const mediaQuery = typeof window.matchMedia === "function" ? window.matchMedia(desktopMediaQuery) : null;
    const updateSupport = (): void => setIsSupported(mediaQuery?.matches ?? isDesktopViewport());

    updateSupport();
    mediaQuery?.addEventListener("change", updateSupport);
    window.addEventListener("resize", updateSupport);
    return () => {
      mediaQuery?.removeEventListener("change", updateSupport);
      window.removeEventListener("resize", updateSupport);
    };
  }, []);

  if (isSupported) {
    return <>{children}</>;
  }

  return (
    <main className="desktopGate shell__unsupported" aria-labelledby="desktop-required-title">
      <section className="desktopGate__card shell__unsupportedCard">
        <p>{ko.desktopWorkspace}</p>
        <h1 id="desktop-required-title">{ko.largerViewportRequired}</h1>
        <p>{ko.desktopRequirement(MIN_DESKTOP_WIDTH, MIN_DESKTOP_HEIGHT)}</p>
      </section>
    </main>
  );
}
