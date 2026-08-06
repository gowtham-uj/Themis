import type { ReactNode } from "react";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-3 border-b border-slate-800 pb-3 text-sm">
        <a href={`/projects/${id}/tasks`} className="font-medium">
          Tasks
        </a>
        <a href={`/projects/${id}/runs/new`}>New run</a>
        <a href="/projects" className="text-slate-500">
          All projects
        </a>
      </nav>
      {children}
    </div>
  );
}
