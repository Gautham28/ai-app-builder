"use client";

import { useEffect, useState } from "react";
import {
  SandpackProvider,
  SandpackLayout,
  SandpackPreview,
} from "@codesandbox/sandpack-react";
import { dracula } from "@codesandbox/sandpack-themes";
import type { FileData } from "@/types/workspace";
import { BASE_DEPENDENCIES, readPreviewPayload } from "@/lib/sandpack";

interface PreviewFullscreenProps {
  initialFileData: FileData | null;
  workspaceId: string | null;
  appTitle: string | null;
}

export default function PreviewFullscreen({
  initialFileData,
  workspaceId,
  appTitle,
}: PreviewFullscreenProps) {
  const [fileData, setFileData] = useState<FileData | null>(initialFileData);

  useEffect(() => {
    const fromStorage = readPreviewPayload(workspaceId);
    if (fromStorage?.fileData) {
      setFileData(fromStorage.fileData);
    }
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
    <div className="preview-frame h-screen w-screen overflow-hidden bg-white">
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
      </SandpackProvider>
    </div>
  );
}
