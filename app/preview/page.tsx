import PreviewFullscreen from "@/components/PreviewFullscreen";
import { getWorkspaceById, getWorkspaceUser } from "@/actions/workspace";
import type { FileData } from "@/types/workspace";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

interface PreviewPageProps {
  searchParams: Promise<{ id?: string }>;
}

function parseFileData(raw: unknown): FileData | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (!f.files || !f.dependencies) return null;
  return raw as FileData;
}

export default async function PreviewPage({ searchParams }: PreviewPageProps) {
  const { userId } = await auth();
  if (!userId) redirect("/");

  const { id } = await searchParams;
  const user = await getWorkspaceUser();

  let initialFileData: FileData | null = null;
  let appTitle: string | null = null;

  if (id) {
    const workspace = await getWorkspaceById(id, user.id);
    initialFileData = parseFileData(workspace.fileData);
    appTitle = workspace.title;
  }

  return (
    <PreviewFullscreen
      initialFileData={initialFileData}
      workspaceId={id ?? null}
      appTitle={appTitle}
    />
  );
}
