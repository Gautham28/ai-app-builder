"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CodePanel } from "./CodePanel";
import { FileData, Message, StatusStep, WorkspaceData } from "@/types/workspace";
import ChatPanel from "./ChatPanel";
import { MIN_CREDITS_TO_GENERATE } from "@/lib/constants";
import { toast } from "sonner";

interface WorkspaceClientProps {
    initialPrompt: string | null;
    userCredits: number;
    userId: string;
    userPlan: string;
    workspace: WorkspaceData | null;
}

function parseMessages(raw: unknown): Message[] {
    if (!Array.isArray(raw)) return [];

    return raw.filter(
      (m): m is Message =>
        typeof m === "object" && m !== null && "role" in m && "content" in m
    );
  } 

  function parseFileData(raw: unknown): FileData | null {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    if (!f.files || !f.dependencies) return null;
    return raw as FileData;
  }

const WorkspaceClient = ({ initialPrompt, userCredits, workspace, userId, userPlan}: WorkspaceClientProps) => {
    const [workspaceId, setWorkspaceId] = useState<string | null>(workspace?.id ?? null,);
    const [messages, setMessages] = useState<Message[]>(
        parseMessages(workspace?.messages),
    );
   
    const [credits, setCredits] = useState(userCredits);

    const [fileData, setFileData] = useState<FileData | null>(
        parseFileData(workspace?.fileData),
    );
    const [isGenerating, setIsGenerating] = useState(false);
    const [statusLog, setStatusLog] = useState<StatusStep[]>([]);

    const messagesRef = useRef<Message[]>(messages);
    useEffect(() => {
      messagesRef.current = messages;
    }, [messages]);
  
    const workspaceIdRef = useRef<string | null>(workspaceId);
    useEffect(() => {
      workspaceIdRef.current = workspaceId;
    }, [workspaceId]);

    const generateAbortRef = useRef<AbortController | null>(null);
    const improveAbortRef = useRef<AbortController | null>(null);
  
    const fileDataRef = useRef<FileData | null>(fileData);
    useEffect(() => {
      fileDataRef.current = fileData;
    }, [fileData]);

    const pushStep = (label: string) => {
        setStatusLog((prev) => [
          ...prev.map((s, i) =>
            i === prev.length - 1 ? { ...s, status: "done" as const } : s
          ),
          { label, status: "running" as const },
        ]);
      };

        const completeSteps = () => {
    setStatusLog((prev) =>
      prev.map((s, i) =>
        i === prev.length - 1 ? { ...s, status: "done" as const } : s
      )
    );
  };

    const handleFilePatch = useCallback((patches: FileData) => {
        setFileData(patches);
    }, []);

    const handleGenerate = useCallback(
        async (prompt: string, imageUrl?: string) => {
          if (isGenerating) return;
          if (credits < MIN_CREDITS_TO_GENERATE) return;
    
          const userMessage: Message = {
            role: "user",
            content: prompt,
            ...(imageUrl ? { imageUrl } : {}),
          };
    
          const currentMessages = messagesRef.current;
          const currentWorkspaceId = workspaceIdRef.current;
    
          setMessages((prev) => [...prev, userMessage]);
          setIsGenerating(true);
          setStatusLog([{ label: "Thinking…", status: "running" }]);

          const abortController = new AbortController();
          generateAbortRef.current = abortController;

          try {
            const conversationHistory = [...currentMessages, userMessage];
            const abortController = new AbortController();
    
            const res = await fetch("/api/gen-ai-code", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: abortController.signal,
              body: JSON.stringify({
                workspaceId: currentWorkspaceId,
                userId,
                messages: conversationHistory,
                fileData: fileDataRef.current,
              }),
            });
            if (res.status === 402) {
                setMessages((prev) => prev.slice(0, -1));
                return;
              }
              if (res.status === 429) {
                toast.error("Too many requests. Please slow down.");
                setMessages((prev) => prev.slice(0, -1));
                return;
              }
              if (!res.ok || !res.body) throw new Error("Generation failed");

              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true});
                const lines = buffer.split("\n\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;

                    try {
                        const event = JSON.parse(line.slice(6));

                        if (event.type === "status"){
                            pushStep(event.message);
                        }else if (event.type === "done") {
                            completeSteps();
                            setWorkspaceId(event.workspaceId);
                            setFileData(event.fileData);
                            setCredits(event.creditsRemaining);
                            setMessages((prev) => [
                              ...prev,
                              { role: "assistant", content: event.assistantMessage },
                            ]);
                            window.history.replaceState(
                              null,
                              "",
                              `/workspace?id=${event.workspaceId}`
                            );
                        } else if (event.type === "error"){
                            throw new Error(event.message);
                        }
                    } catch (error) {
                        
                    }
                }
              }

        } catch (err){
          if (err instanceof Error && err.name === "AbortError"){
            setMessages((prev) => prev.slice(0, -1));
            return;
          }
            toast.error(
                err instanceof Error ? err.message : "Something went wrong",
            );
            setMessages((prev) => prev.slice(0, -1));
        } finally {
            generateAbortRef.current = null;
            setIsGenerating(false);
            setStatusLog([]);
        }
    },
        [credits, isGenerating, userId],
    );

    const handleStop = useCallback(() => {
      generateAbortRef.current?.abort();
      improveAbortRef.current?.abort();
    }, [])

    return (
        <div className="flex h-[calc(100vh-4rem)] overflow-hidden bg-[#0a0a0a]">
            <ChatPanel
                messages={messages}
                isGenerating={isGenerating}
                isImproving={false}
                statusLog={statusLog}
                credits={credits}
                initialPrompt={initialPrompt}
                onStop={handleStop}
                onGenerate={handleGenerate}
                userId={userId}
                workspaceId={workspaceId}
                appTitle={fileData?.title ?? workspace?.title ?? null}
            />

            <CodePanel 
            fileData={fileData}
            isGenerating={isGenerating}
            statusLog={statusLog}
            onFilePatch={handleFilePatch}
            />
        </div>
    )
}

export default WorkspaceClient;