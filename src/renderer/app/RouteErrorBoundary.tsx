import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";
import type { ReactElement } from "react";

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
  const message = describeRouteError(error);

  return (
    <main className="routeError" aria-labelledby="route-error-title">
      <section className="routeError__card" role="alert">
        <p>Route unavailable</p>
        <h1 id="route-error-title">This view could not be rendered.</h1>
        <p>{message}</p>
        <Link to="/">Return to overview</Link>
      </section>
    </main>
  );
}
