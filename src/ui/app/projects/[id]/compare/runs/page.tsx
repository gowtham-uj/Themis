/**
 * Two-run side-by-side compare — server-prefetches when a&b are present.
 * Spec: plan/ui.md §6 Two-run side-by-side.
 */

import {
  getRunCompare,
  type RunCompareApi,
} from "../../../../../lib/api.js";
import { RunCompareView } from "./RunCompareView.js";

export const dynamic = "force-dynamic";

function first(
  v: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function RunComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const a = first(sp.a) ?? "";
  const b = first(sp.b) ?? "";

  let data: RunCompareApi | null = null;
  let error: string | null = null;

  if (a && b) {
    try {
      data = await getRunCompare(id, a, b);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-100">
          Compare failed ({error}). Re-select run ids below.
        </p>
      )}
      <RunCompareView
        projectId={id}
        initialA={a}
        initialB={b}
        initialData={data}
        initialError={error}
      />
    </div>
  );
}
