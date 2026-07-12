import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";
import type { ReactElement } from "react";
import { ko, localizeError } from "../platform/i18n.js";

function describeRouteError(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    return error.statusText || `Route failed with HTTP ${error.status}.`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function RouteErrorBoundary(): ReactElement {
  const error = useRouteError();
  const message = localizeError(describeRouteError(error));

  return (
    <main className="routeError" aria-labelledby="route-error-title">
      <section className="routeError__card" role="alert">
        <p>{ko.routeUnavailable}</p>
        <h1 id="route-error-title">{ko.routeCouldNotRender}</h1>
        <p>{message}</p>
        <Link to="/">{ko.returnToOverview}</Link>
      </section>
    </main>
  );
}
