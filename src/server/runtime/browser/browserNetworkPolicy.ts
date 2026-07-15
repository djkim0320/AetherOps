import type { BrowserContext, Route } from "playwright";
import { PublicUrlPolicy } from "../tools/publicUrlPolicy.js";
import type { ResearchSourceAccessPolicy } from "../../../core/shared/adapterTypes.js";
import { assertSourceAccess } from "../../../core/tools/sourceAccessPolicy.js";
import { redactAuditUrl, type BoundedNetworkAuditEvent } from "../tools/boundedHttpClient.js";

const LOCAL_SCHEMES = new Set(["about:", "blob:", "data:"]);

export interface BrowserRoutingContext {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<unknown>;
}

export async function installBrowserNetworkPolicy(
  context: BrowserRoutingContext,
  policy: PublicUrlPolicy,
  sourceAccess?: ResearchSourceAccessPolicy,
  onNetworkAudit?: (audit: BoundedNetworkAuditEvent) => void | Promise<void>
): Promise<void> {
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    try {
      const method = route.request().method();
      if (method !== "GET" && method !== "HEAD") throw new Error(`Browser network method ${method} is not permitted.`);
      const protocol = new URL(requestUrl).protocol;
      if (LOCAL_SCHEMES.has(protocol)) {
        await route.continue();
        return;
      }
      await policy.assertPublicHttpUrl(requestUrl);
      if (sourceAccess) assertSourceAccess(sourceAccess, requestUrl);
      await onNetworkAudit?.({
        url: redactAuditUrl(requestUrl),
        redirectChain: [redactAuditUrl(requestUrl)],
        policyDecision: "allowed",
        auditedAt: new Date().toISOString()
      });
      await route.continue();
    } catch (error) {
      await onNetworkAudit?.({
        url: redactAuditUrl(requestUrl),
        redirectChain: [redactAuditUrl(requestUrl)],
        policyDecision: "denied",
        reason: error instanceof Error ? error.message : String(error),
        auditedAt: new Date().toISOString()
      });
      await route.abort("blockedbyclient");
    }
  });
}

export async function assertPublicNavigationUrl(policy: PublicUrlPolicy, value: string): Promise<string> {
  return policy.assertPublicHttpUrl(value);
}

export type BrowserNetworkContext = Pick<BrowserContext, "route">;
