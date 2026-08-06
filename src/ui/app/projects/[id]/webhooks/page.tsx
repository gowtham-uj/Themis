/**
 * Outbound webhooks surface — server-prefetches subscriptions; client handles
 * CRUD + deliveries + test-fire. Spec: plan/api.md §Outbound webhooks.
 */

import { getWebhooks, type OutboundWebhook } from "../../../../lib/api.js";
import { WebhooksClient } from "./WebhooksClient.js";

export const dynamic = "force-dynamic";

export default async function WebhooksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let webhooks: OutboundWebhook[] = [];
  let error: string | null = null;
  try {
    webhooks = await getWebhooks(id);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-100">
          API unavailable ({error}). Showing empty list — create still posts to
          the API.
        </p>
      )}
      <WebhooksClient projectId={id} initialWebhooks={webhooks} />
    </div>
  );
}
