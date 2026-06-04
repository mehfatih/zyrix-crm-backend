// ============================================================================
// GOOGLE DRIVE HELPERS — Sprint 5
// ----------------------------------------------------------------------------
// All operations run under the non-sensitive `drive.file` scope, so they only
// ever touch files/folders our app created (the "Zyrix CRM" folder) or files
// the user explicitly picked. We never browse the merchant's Drive.
// ============================================================================

import { Readable } from "stream";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { integrationError } from "../../lib/errors/integrationErrors";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const FOLDER_NAME = "Zyrix CRM";

export function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

/**
 * Find (or create) the "Zyrix CRM" folder in the merchant's Drive and return
 * its id. Under drive.file, the list only sees folders our app created, so a
 * miss means we create it fresh.
 */
export async function ensureZyrixFolder(client: OAuth2Client): Promise<string> {
  const drive = google.drive({ version: "v3", auth: client });
  try {
    const existing = await drive.files.list({
      q: `name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
      pageSize: 1,
    });
    const found = existing.data.files?.[0]?.id;
    if (found) return found;

    const created = await drive.files.create({
      requestBody: { name: FOLDER_NAME, mimeType: FOLDER_MIME },
      fields: "id",
    });
    if (!created.data.id) {
      throw integrationError("GOOGLE_API_FAILED", "Drive folder creation returned no id", {
        platform: "google",
      });
    }
    return created.data.id;
  } catch (err) {
    if ((err as { code?: string }).code === "GOOGLE_API_FAILED") throw err;
    throw integrationError(
      "GOOGLE_API_FAILED",
      `Failed to ensure Zyrix CRM Drive folder: ${(err as Error).message}`,
      { platform: "google" }
    );
  }
}

export interface UploadedFile {
  id: string;
  webViewLink: string;
}

/**
 * Upload a binary file (e.g. a generated PDF) into the given folder and return
 * its id + shareable webViewLink (opens in Drive for the owner).
 */
export async function uploadFileToFolder(params: {
  client: OAuth2Client;
  folderId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<UploadedFile> {
  const { client, folderId, filename, mimeType, buffer } = params;
  const drive = google.drive({ version: "v3", auth: client });
  try {
    const created = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType, body: Readable.from(buffer) },
      fields: "id, webViewLink",
    });
    if (!created.data.id) {
      throw integrationError("GOOGLE_API_FAILED", "Drive upload returned no id", {
        platform: "google",
      });
    }
    return {
      id: created.data.id,
      webViewLink:
        created.data.webViewLink ?? `https://drive.google.com/file/d/${created.data.id}/view`,
    };
  } catch (err) {
    if ((err as { code?: string }).code === "GOOGLE_API_FAILED") throw err;
    throw integrationError(
      "GOOGLE_API_FAILED",
      `Drive upload failed: ${(err as Error).message}`,
      { platform: "google" }
    );
  }
}
