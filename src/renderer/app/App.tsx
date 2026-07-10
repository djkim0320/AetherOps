import { RouterProvider } from "react-router-dom";
import { type ReactElement } from "react";
import { AppProviders } from "./AppProviders.js";
import { DesktopRequiredBoundary } from "./DesktopRequiredBoundary.js";
import { appRouter } from "./routerConfig.js";

export function App(): ReactElement {
  return (
    <AppProviders>
      <DesktopRequiredBoundary>
        <RouterProvider router={appRouter} />
      </DesktopRequiredBoundary>
    </AppProviders>
  );
}
