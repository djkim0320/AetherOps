import type { BrowserContext, Route } from "playwright";
import { PublicUrlPolicy } from "../tools/publicUrlPolicy.js";

const LOCAL_SCHEMES = new Set(["about:", "blob:", "data:"]);

export interface BrowserRoutingContext {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<unknown>;
}

export async function installBrowserNetworkPolicy(context: BrowserRoutingContext, policy: PublicUrlPolicy): Promise<void> {
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    try {
      const protocol = new URL(requestUrl).protocol;
      if (LOCAL_SCHEMES.has(protocol)) {
        await route.continue();
        return;
      }
      await policy.assertPublicHttpUrl(requestUrl);
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
}

export async function assertPublicNavigationUrl(policy: PublicUrlPolicy, value: string): Promise<string> {
  return policy.assertPublicHttpUrl(value);
}

export type BrowserNetworkContext = Pick<BrowserContext, "route">;
