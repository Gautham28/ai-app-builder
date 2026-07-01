"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { deleteProject, type ProjectSummary } from "@/actions/projects";
import { Button } from "@/components/ui/button";

interface ProjectCardProps {
  projects: ProjectSummary[];
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

export function ProjectCard({ projects }: ProjectCardProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleDelete = (workspaceId: string) => {
    startTransition(async () => {
      await deleteProject(workspaceId);
      router.refresh();
    });
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <div
          key={project.id}
          className="group relative rounded-xl border border-white/8 bg-white/3 p-4 transition-colors hover:border-white/15 hover:bg-white/5"
        >
          <Link href={`/workspace?id=${project.id}`} className="block">
            <h3 className="mb-1 truncate text-sm font-medium text-white/80">
              {project.title ?? "Untitled project"}
            </h3>
            <p className="mb-3 line-clamp-2 text-xs text-white/30">
              {project.firstPrompt ?? "No description"}
            </p>
            <div className="flex items-center justify-between text-[11px] text-white/25">
              <span className="inline-flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                {project.messageCount} message
                {project.messageCount !== 1 ? "s" : ""}
              </span>
              <span>Updated {formatDate(project.updatedAt)}</span>
            </div>
          </Link>

          <Button
            variant="ghost"
            size="icon"
            disabled={isPending}
            onClick={() => handleDelete(project.id)}
            className="absolute right-2 top-2 h-7 w-7 text-white/20 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
