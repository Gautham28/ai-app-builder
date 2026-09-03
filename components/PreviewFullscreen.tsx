"use client";

import { useEffect, useState } from "react";
import {
  SandpackProvider,
  SandpackLayout,
  SandpackPreview,
  useSandpack,
} from "@codesandbox/sandpack-react";
import { dracula } from "@codesandbox/sandpack-themes";
import { RefreshCw } from "lucide-react";
import type { FileData } from "@/types/workspace";
import { BASE_DEPENDENCIES, readPreviewPayload } from "@/lib/sandpack";

interface PreviewFullscreenProps {
  initialFileData: FileData | null;
  workspaceId: string | null;
  appTitle: string | null;
}

function PreviewInner() {
  const { dispatch } = useSandpack();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefreshPreview = () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    dispatch({ type: "refresh" });
    window.setTimeout(() => setIsRefreshing(false), 600);
  };

  return (
    <>
      <SandpackLayout
        className="h-full!"
        style={{
          height: "100%",
          border: "none",
          borderRadius: 0,
          background: "transparent",
        }}
      >
        <SandpackPreview
          className="h-full"
          style={{ height: "100%", width: "100%", flex: 1 }}
          showNavigator={false}
          showOpenInCodeSandbox={false}
          showRefreshButton={false}
          showOpenNewtab={false}
          showRestartButton={false}
        />
      </SandpackLayout>

      <button
        type="button"
        onClick={handleRefreshPreview}
        title="Refresh preview"
        aria-label="Refresh preview"
        className="absolute bottom-3 right-3 z-30 flex h-8 w-8 items-center justify-center rounded-full border border-black/10 bg-white text-black/70 shadow-md transition-colors hover:bg-black/[0.03] hover:text-black"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`}
        />
      </button>
    </>
  );
}

export default function PreviewFullscreen({
  initialFileData,
  workspaceId,
  appTitle,
}: PreviewFullscreenProps) {
  const [fileData, setFileData] = useState<FileData | null>(() => {
    if (initialFileData) return initialFileData;
    if (typeof window !== "undefined") {
      return readPreviewPayload(workspaceId)?.fileData ?? null;
    }
    return null;
  });

  useEffect(() => {
    const handleStorage = () => {
      const fromStorage = readPreviewPayload(workspaceId);
      if (fromStorage?.fileData) {
        setFileData(fromStorage.fileData);
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [workspaceId]);

  useEffect(() => {
    const title = fileData?.title ?? appTitle;
    if (title) document.title = title;
  }, [fileData?.title, appTitle]);

  if (!fileData?.files) {
    return (
      <div className="flex h-screen items-center justify-center bg-white text-sm text-black/40">
        No preview available
      </div>
    );
  }

  const dependencies = {
    ...BASE_DEPENDENCIES,
    ...fileData.dependencies,
  };

  return (
    <div className="preview-frame relative h-screen w-screen overflow-hidden bg-white">
      <SandpackProvider
        template="react"
        theme={dracula}
        files={fileData.files}
        customSetup={{ dependencies }}
        className="flex h-full min-h-0 flex-col"
        style={{ height: "100%" }}
        options={{
          externalResources: ["https://cdn.tailwindcss.com"],
          recompileMode: "delayed",
          recompileDelay: 300,
        }}
      >
        <PreviewInner />
      </SandpackProvider>
    </div>
  );
}
