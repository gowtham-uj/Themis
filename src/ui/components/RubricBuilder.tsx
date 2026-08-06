"use client";

/**
 * Simple criterion editor — add/edit criteria for a task rubric.
 * POSTs as rubric_json (plan/ui.md §1, plan/rubric.md).
 */

import { useCallback } from "react";
import type { Anchors, AppliesTo, Criterion, Rubric, RubricAxis } from "../lib/api.js";

const AXES: RubricAxis[] = ["A", "B", "C", "D", "E", "F", "G", "H"];
const APPLIES: AppliesTo[] = ["both", "coding", "general"];

export interface RubricBuilderProps {
  value: Rubric;
  onChange: (next: Rubric) => void;
  className?: string;
}

function emptyCriterion(index: number): Criterion {
  const id = `C${index + 1}`;
  return {
    id,
    axis: "A",
    label: "",
    weight: 1,
    appliesTo: "both",
    anchors: { full: "", partial: "", none: "" },
  };
}

export function RubricBuilder({ value, onChange, className = "" }: RubricBuilderProps) {
  const criteria = value.criteria ?? [];

  const updateCriterion = useCallback(
    (index: number, patch: Partial<Criterion> | { anchors: Partial<Anchors> }) => {
      const next = criteria.map((c, i) => {
        if (i !== index) return c;
        if ("anchors" in patch && patch.anchors) {
          return { ...c, anchors: { ...c.anchors, ...patch.anchors } };
        }
        return { ...c, ...(patch as Partial<Criterion>) };
      });
      onChange({ ...value, criteria: next });
    },
    [criteria, onChange, value],
  );

  const addCriterion = () => {
    onChange({
      ...value,
      criteria: [...criteria, emptyCriterion(criteria.length)],
    });
  };

  const removeCriterion = (index: number) => {
    onChange({
      ...value,
      criteria: criteria.filter((_, i) => i !== index),
    });
  };

  return (
    <div className={`space-y-3 ${className}`} data-testid="rubric-builder">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Rubric criteria</h3>
        <button
          type="button"
          data-testid="add-criterion"
          className="rounded bg-slate-700 px-2 py-1 text-xs text-white"
          onClick={addCriterion}
        >
          Add criterion
        </button>
      </div>

      {criteria.length === 0 && (
        <p className="text-xs text-slate-500">
          Add at least one criterion (id, axis A–H, label, weight, anchors).
        </p>
      )}

      {criteria.map((c, i) => (
        <div
          key={`${c.id}-${i}`}
          data-testid={`criterion-${i}`}
          className="space-y-2 rounded border border-slate-700 bg-slate-900/50 p-3"
        >
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <label className="text-xs text-slate-400">
              Id
              <input
                className="mt-0.5 w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-white"
                value={c.id}
                onChange={(e) => updateCriterion(i, { id: e.target.value })}
              />
            </label>
            <label className="text-xs text-slate-400">
              Axis
              <select
                className="mt-0.5 w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-white"
                value={c.axis}
                onChange={(e) =>
                  updateCriterion(i, { axis: e.target.value as RubricAxis })
                }
              >
                {AXES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-400">
              Label
              <input
                className="mt-0.5 w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-white"
                value={c.label}
                onChange={(e) => updateCriterion(i, { label: e.target.value })}
              />
            </label>
            <label className="text-xs text-slate-400">
              Weight
              <input
                type="number"
                step="0.1"
                min="0"
                className="mt-0.5 w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-white"
                value={c.weight}
                onChange={(e) =>
                  updateCriterion(i, { weight: Number(e.target.value) || 0 })
                }
              />
            </label>
            <label className="text-xs text-slate-400">
              Applies to
              <select
                className="mt-0.5 w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-white"
                value={c.appliesTo}
                onChange={(e) =>
                  updateCriterion(i, {
                    appliesTo: e.target.value as AppliesTo,
                  })
                }
              >
                {APPLIES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            <label className="text-xs text-slate-400">
              Anchor full (1.0)
              <textarea
                rows={2}
                className="mt-0.5 w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-white"
                value={c.anchors.full}
                onChange={(e) =>
                  updateCriterion(i, { anchors: { full: e.target.value } })
                }
              />
            </label>
            <label className="text-xs text-slate-400">
              Anchor partial (0.5)
              <textarea
                rows={2}
                className="mt-0.5 w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-white"
                value={c.anchors.partial}
                onChange={(e) =>
                  updateCriterion(i, { anchors: { partial: e.target.value } })
                }
              />
            </label>
            <label className="text-xs text-slate-400">
              Anchor none (0.0)
              <textarea
                rows={2}
                className="mt-0.5 w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-white"
                value={c.anchors.none}
                onChange={(e) =>
                  updateCriterion(i, { anchors: { none: e.target.value } })
                }
              />
            </label>
          </div>

          <button
            type="button"
            className="text-xs text-red-400 hover:underline"
            onClick={() => removeCriterion(i)}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

/** Serialize rubric for API body as rubric_json (object form). */
export function rubricToJsonPayload(rubric: Rubric): {
  rubric: Rubric;
  rubric_json: Rubric;
} {
  return { rubric, rubric_json: rubric };
}
