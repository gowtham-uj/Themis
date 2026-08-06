import { listProjects } from "../../lib/api.js";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  let error: string | null = null;
  try {
    projects = await listProjects();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Projects</h1>
      {error && (
        <p className="rounded border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-100">
          Could not load projects from API ({error}). Ensure the API is running
          and AGENTEVAL_API_URL is set if needed.
        </p>
      )}
      {!error && projects.length === 0 && (
        <p className="text-slate-400">No projects yet.</p>
      )}
      <ul className="divide-y divide-slate-800 rounded border border-slate-800">
        {projects.map((p) => (
          <li key={p.id} className="flex items-center justify-between px-4 py-3">
            <div>
              <a
                href={`/projects/${p.id}/tasks`}
                className="font-medium text-white hover:underline"
              >
                {p.name}
              </a>
              <div className="text-xs text-slate-500">{p.slug}</div>
            </div>
            <div className="flex gap-2 text-sm">
              <a href={`/projects/${p.id}/tasks`}>Tasks</a>
              <a href={`/projects/${p.id}/runs/new`}>New run</a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
