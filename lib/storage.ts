import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export { MAX_IMAGE_BYTES } from "./constants";

export const WORKSPACE_IMAGE_BUCKET = "workspace-images";

export const ALLOWED_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

export type AllowedImageType = keyof typeof ALLOWED_IMAGE_TYPES;

/**
 * Identifies the real type from the file's leading bytes. A client-supplied
 * Content-Type is not evidence of anything: an HTML payload declared as
 * image/png would otherwise be stored and served from our storage domain.
 */
export function sniffImageType(bytes: Uint8Array): AllowedImageType | null {
  const startsWith = (...signature: number[]) =>
    signature.every((byte, i) => bytes[i] === byte);

  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return "image/png";
  }
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  // RIFF....WEBP
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

let cached: SupabaseClient | null = null;

/**
 * Service-role client. Server-only: this key bypasses row level security, so it
 * must never reach the browser. Created lazily so a missing key surfaces as a
 * request error rather than a build failure.
 */
export function getStorageClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase storage is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
