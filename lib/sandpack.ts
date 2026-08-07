import type { FileData } from "@/types/workspace";

export const PREVIEW_STORAGE_KEY = "bloom:preview-payload";

export const BASE_DEPENDENCIES: Record<string, string> = {
  "react-is": "latest",
  "react-router-dom": "latest",
  "lucide-react": "latest",
  recharts: "latest",
  "date-fns": "latest",
  "framer-motion": "latest",
  "react-hook-form": "latest",
  "@hookform/resolvers": "latest",
  zod: "latest",
  "@radix-ui/react-dialog": "latest",
  "@radix-ui/react-dropdown-menu": "latest",
  "@radix-ui/react-tabs": "latest",
  "@radix-ui/react-tooltip": "latest",
  "@radix-ui/react-accordion": "latest",
  "@radix-ui/react-select": "latest",
  axios: "latest",
  clsx: "latest",
  "class-variance-authority": "latest",
  "tailwind-merge": "latest",
};

export interface PreviewPayload {
  fileData: FileData;
  workspaceId: string | null;
  savedAt: number;
}

export function storePreviewPayload(
  fileData: FileData,
  workspaceId: string | null,
) {
  const payload: PreviewPayload = {
    fileData,
    workspaceId,
    savedAt: Date.now(),
  };
  sessionStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(payload));
}

export function readPreviewPayload(
  workspaceId?: string | null,
): PreviewPayload | null {
  try {
    const raw = sessionStorage.getItem(PREVIEW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PreviewPayload;
    if (!parsed?.fileData?.files) return null;
    if (
      workspaceId &&
      parsed.workspaceId &&
      parsed.workspaceId !== workspaceId
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
