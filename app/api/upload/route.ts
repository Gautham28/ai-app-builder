import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { db } from "@/lib/prisma";
import { ajUpload } from "@/lib/arcjet";
import { MAX_IMAGE_BYTES } from "@/lib/constants";
import {
  ALLOWED_IMAGE_TYPES,
  WORKSPACE_IMAGE_BUCKET,
  getStorageClient,
  sniffImageType,
} from "@/lib/storage";

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId)
    return Response.json({ message: "Unauthorized" }, { status: 401 });

  const decision = await ajUpload.protect(request, {
    requested: 1,
    userId: clerkId,
  });
  if (decision.isDenied()) {
    return Response.json(
      { message: "Too many uploads. Please slow down." },
      { status: 429 }
    );
  }

  // Cheap rejection before buffering the body into memory.
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_IMAGE_BYTES + 4096) {
    return Response.json({ message: "Image is too large" }, { status: 413 });
  }

  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user)
    return Response.json({ message: "User not found" }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ message: "Invalid upload" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ message: "No file provided" }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ message: "File is empty" }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Response.json({ message: "Image is too large" }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    return Response.json(
      { message: "Only PNG, JPEG, WebP, and GIF images are supported" },
      { status: 415 }
    );
  }

  // The workspace is optional (the first prompt has no workspace yet), but when
  // present it must belong to the caller.
  const requestedWorkspaceId = form.get("workspaceId");
  let workspaceSegment = "unassigned";
  if (typeof requestedWorkspaceId === "string" && requestedWorkspaceId) {
    const owned = await db.workspace.findFirst({
      where: { id: requestedWorkspaceId, userId: user.id },
      select: { id: true },
    });
    if (!owned) {
      return Response.json({ message: "Workspace not found" }, { status: 404 });
    }
    workspaceSegment = owned.id;
  }

  // Path is built from server-derived values only. A client-supplied path with
  // upsert enabled would let one user overwrite another user's images.
  const extension = ALLOWED_IMAGE_TYPES[contentType];
  const objectPath = `${user.id}/${workspaceSegment}/${crypto.randomUUID()}.${extension}`;

  try {
    const storage = getStorageClient();
    const { error } = await storage.storage
      .from(WORKSPACE_IMAGE_BUCKET)
      .upload(objectPath, bytes, {
        contentType,
        upsert: false,
        cacheControl: "3600",
      });

    if (error) throw error;

    const { data } = storage.storage
      .from(WORKSPACE_IMAGE_BUCKET)
      .getPublicUrl(objectPath);

    return Response.json({ url: data.publicUrl });
  } catch (err) {
    console.error("[upload] failed:", err);
    return Response.json({ message: "Upload failed" }, { status: 500 });
  }
}

export const runtime = "nodejs";
