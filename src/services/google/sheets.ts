// ============================================================================
// GOOGLE SHEETS EXPORT — Sprint 5
// ----------------------------------------------------------------------------
// Creates a NEW spreadsheet inside the merchant's "Zyrix CRM" Drive folder and
// writes the export rows with a bold frozen header + auto-filter. Works under
// the non-sensitive `drive.file` scope because the spreadsheet is created by
// our app (Drive create with the spreadsheet mimeType), so the Sheets API may
// then read/write it.
// ============================================================================

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { integrationError } from "../../lib/errors/integrationErrors";

const SHEET_MIME = "application/vnd.google-apps.spreadsheet";

/** Stringify a cell value the way the CSV/XLSX exporters do (dates already ISO). */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export interface SheetExportResult {
  url: string;
  rowCount: number;
}

/**
 * Create a formatted spreadsheet in the given folder and return its URL +
 * data row count (excluding the header).
 */
export async function createSheetExport(params: {
  client: OAuth2Client;
  folderId: string;
  title: string;
  headers: string[];
  rows: Record<string, any>[];
}): Promise<SheetExportResult> {
  const { client, folderId, title, headers, rows } = params;
  const drive = google.drive({ version: "v3", auth: client });
  const sheets = google.sheets({ version: "v4", auth: client });

  try {
    // 1) Create the (empty) spreadsheet inside the Zyrix CRM folder.
    const created = await drive.files.create({
      requestBody: { name: title, mimeType: SHEET_MIME, parents: [folderId] },
      fields: "id, webViewLink",
    });
    const spreadsheetId = created.data.id;
    if (!spreadsheetId) {
      throw integrationError("GOOGLE_API_FAILED", "Spreadsheet creation returned no id", {
        platform: "google",
      });
    }

    // 2) Write header + data as a values matrix.
    const matrix: string[][] = [headers, ...rows.map((r) => headers.map((h) => cell(r[h])))];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "A1",
      valueInputOption: "RAW",
      requestBody: { values: matrix },
    });

    // 3) Format: bold + frozen header row, auto-filter over the full range.
    const sheetId = await firstSheetId(sheets, spreadsheetId);
    const columnCount = Math.max(headers.length, 1);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: "gridProperties.frozenRowCount",
            },
          },
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.03, green: 0.57, blue: 0.7 },
                  horizontalAlignment: "LEFT",
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)",
            },
          },
          {
            setBasicFilter: {
              filter: {
                range: {
                  sheetId,
                  startRowIndex: 0,
                  startColumnIndex: 0,
                  endColumnIndex: columnCount,
                },
              },
            },
          },
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: columnCount },
            },
          },
        ],
      },
    });

    return {
      url:
        created.data.webViewLink ??
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      rowCount: rows.length,
    };
  } catch (err) {
    if ((err as { code?: string }).code === "GOOGLE_API_FAILED") throw err;
    throw integrationError(
      "GOOGLE_API_FAILED",
      `Google Sheets export failed: ${(err as Error).message}`,
      { platform: "google" }
    );
  }
}

/**
 * Read the first sheet of a picked spreadsheet into { headers, rows }. Works
 * under drive.file because the user explicitly picked the file via the Google
 * Picker (which grants our app access to that file).
 */
export async function readSheetValues(
  client: OAuth2Client,
  fileId: string
): Promise<{ headers: string[]; rows: string[][] }> {
  const sheets = google.sheets({ version: "v4", auth: client });
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: fileId,
      fields: "sheets.properties.title",
    });
    const title = meta.data.sheets?.[0]?.properties?.title ?? "Sheet1";
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: fileId,
      range: `'${title}'`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = (resp.data.values ?? []) as unknown[][];
    if (values.length === 0) return { headers: [], rows: [] };
    const headers = values[0].map((c) => cell(c).trim());
    const rows = values.slice(1).map((r) => headers.map((_, i) => cell(r[i])));
    return { headers, rows };
  } catch (err) {
    throw integrationError(
      "GOOGLE_API_FAILED",
      `Reading Google Sheet failed: ${(err as Error).message}`,
      { platform: "google" }
    );
  }
}

async function firstSheetId(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string
): Promise<number> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.sheetId",
  });
  return meta.data.sheets?.[0]?.properties?.sheetId ?? 0;
}
