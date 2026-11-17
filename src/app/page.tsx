import { KnowledgeConsole, type WorkspaceView } from "@/components/knowledge-console";

export const dynamic = "force-dynamic";

const ALLOWED_VIEWS = new Set<WorkspaceView>(["files", "assistant", "sql", "charts", "graph"]);

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ view?: string | string[] }>;
}) {
  const params = searchParams ? await searchParams : {};
  const rawView = Array.isArray(params.view) ? params.view[0] : params.view;
  const initialView: WorkspaceView =
    rawView && ALLOWED_VIEWS.has(rawView as WorkspaceView) ? (rawView as WorkspaceView) : "files";

  return <KnowledgeConsole initialView={initialView} />;
}
