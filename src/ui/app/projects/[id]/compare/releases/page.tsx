/**
 * Release compare — suite-level A→B across all tasks.
 * Spec: plan/ui.md §6c Release compare.
 */

import {
  getReleaseCompare,
  type ReleaseCompareApi,
} from "../../../../../lib/api.js";
import { ReleaseCompareView } from "./ReleaseCompareView.js";

export const dynamic = "force-dynamic";

function first(
  v: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function ReleaseComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const from = first(sp.from) ?? "";
  const to = first(sp.to) ?? "";

  let data: ReleaseCompareApi | null = null;
  let error: string | null = null;

  if (from && to) {
    try {
      data = await getReleaseCompare(id, from, to);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-100">
          Release compare failed ({error}). Adjust from/to versions below.
        </p>
      )}
      <ReleaseCompareView
        projectId={id}
        initialFrom={from}
        initialTo={to}
        initialData={data}
        initialError={error}
      />
    </div>
  );
}
