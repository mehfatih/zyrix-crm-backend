import { prisma } from "../config/database";

// ============================================================================
// CSV CUSTOMER IMPORT SERVICE
// Parse CSV, validate, bulk-insert with duplicate detection
// ============================================================================

export interface ImportRow {
  fullName: string;
  email?: string;
  phone?: string;
  whatsappPhone?: string;
  companyName?: string;
  position?: string;
  country?: string;
  city?: string;
  address?: string;
  status?: string;
  notes?: string;
  source?: string;
}

export interface ImportResult {
  totalRows: number;
  imported: number;
  skipped: number;
  errors: { row: number; message: string; data?: any }[];
  duplicates: { row: number; email?: string; phone?: string }[];
}

// Column name mappings (flexible — supports various header styles)
const FIELD_ALIASES: Record<string, string> = {
  // Full Name
  fullname: "fullName",
  full_name: "fullName",
  name: "fullName",
  "الاسم": "fullName",
  "الاسم الكامل": "fullName",
  ad: "fullName",
  isim: "fullName",
  // Email
  email: "email",
  mail: "email",
  "e-mail": "email",
  "e_mail": "email",
  "البريد": "email",
  "البريد الإلكتروني": "email",
  eposta: "email",
  // Phone
  phone: "phone",
  mobile: "phone",
  tel: "phone",
  telephone: "phone",
  "الهاتف": "phone",
  "الجوال": "phone",
  telefon: "phone",
  // WhatsApp
  whatsapp: "whatsappPhone",
  whatsapp_phone: "whatsappPhone",
  whatsappphone: "whatsappPhone",
  wa: "whatsappPhone",
  "واتساب": "whatsappPhone",
  // Company
  company: "companyName",
  companyname: "companyName",
  company_name: "companyName",
  organization: "companyName",
  "الشركة": "companyName",
  sirket: "companyName",
  // Position
  position: "position",
  title: "position",
  "job_title": "position",
  "المنصب": "position",
  pozisyon: "position",
  // Country
  country: "country",
  "الدولة": "country",
  ulke: "country",
  // City
  city: "city",
  "المدينة": "city",
  sehir: "city",
  // Address
  address: "address",
  "العنوان": "address",
  adres: "address",
  // Status
  status: "status",
  "الحالة": "status",
  durum: "status",
  // Notes
  notes: "notes",
  note: "notes",
  comments: "notes",
  "ملاحظات": "notes",
  notlar: "notes",
  // Source
  source: "source",
  origin: "source",
  "المصدر": "source",
  kaynak: "source",
};

// Parse CSV text into array of row objects with header normalization
export function parseCsv(csvText: string): {
  rows: Record<string, string>[];
  headers: string[];
} {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { rows: [], headers: [] };

  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result.map((v) => v.trim());
  };

  const headers = parseLine(lines[0]).map((h) =>
    h.toLowerCase().trim().replace(/\s+/g, "_")
  );

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      const canonical = FIELD_ALIASES[h] || h;
      row[canonical] = values[idx] || "";
    });
    rows.push(row);
  }

  return { rows, headers };
}

export async function importCustomers(
  companyId: string,
  csvText: string,
  options: { ownerId?: string; skipDuplicates?: boolean } = {}
): Promise<ImportResult> {
  const { rows } = parseCsv(csvText);
  const result: ImportResult = {
    totalRows: rows.length,
    imported: 0,
    skipped: 0,
    errors: [],
    duplicates: [],
  };

  // Build lookup maps for fast duplicate check
  const existingEmails = new Set<string>();
  const existingPhones = new Set<string>();
  if (options.skipDuplicates) {
    const existing = await prisma.customer.findMany({
      where: { companyId },
      select: { email: true, phone: true, whatsappPhone: true },
    });
    for (const c of existing) {
      if (c.email) existingEmails.add(c.email.toLowerCase().trim());
      if (c.phone) existingPhones.add(c.phone.replace(/[^0-9+]/g, ""));
      if (c.whatsappPhone)
        existingPhones.add(c.whatsappPhone.replace(/[^0-9+]/g, ""));
    }
  }

  const toCreate: any[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Partial<ImportRow>;
    const rowNum = i + 2; // header is row 1

    // Required: fullName
    if (!row.fullName || row.fullName.trim().length === 0) {
      result.errors.push({
        row: rowNum,
        message: "Missing required field: fullName",
        data: row,
      });
      result.skipped++;
      continue;
    }

    // Basic email validation
    const email = row.email?.trim().toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      result.errors.push({
        row: rowNum,
        message: `Invalid email format: ${email}`,
      });
      result.skipped++;
      continue;
    }

    const phone = row.phone?.trim() || null;
    const whatsappPhone = row.whatsappPhone?.trim() || null;

    // Dedup check
    if (options.skipDuplicates) {
      const phoneNormalized = phone?.replace(/[^0-9+]/g, "") || "";
      const waNormalized = whatsappPhone?.replace(/[^0-9+]/g, "") || "";
      if (
        (email && existingEmails.has(email)) ||
        (phoneNormalized && existingPhones.has(phoneNormalized)) ||
        (waNormalized && existingPhones.has(waNormalized))
      ) {
        result.duplicates.push({ row: rowNum, email: email || undefined, phone: phone || undefined });
        result.skipped++;
        continue;
      }
      if (email) existingEmails.add(email);
      if (phone) existingPhones.add(phone.replace(/[^0-9+]/g, ""));
    }

    toCreate.push({
      companyId,
      ownerId: options.ownerId || null,
      fullName: row.fullName.trim(),
      email,
      phone,
      whatsappPhone,
      companyName: row.companyName?.trim() || null,
      position: row.position?.trim() || null,
      country: row.country?.trim() || null,
      city: row.city?.trim() || null,
      address: row.address?.trim() || null,
      status: (row.status?.trim().toLowerCase() as any) || "new",
      notes: row.notes?.trim() || null,
      source: row.source?.trim() || "csv_import",
    });
  }

  if (toCreate.length > 0) {
    // createMany is faster but loses the individual IDs. For import that's fine.
    const batch = await prisma.customer.createMany({
      data: toCreate,
      skipDuplicates: false,
    });
    result.imported = batch.count;
  }

  return result;
}
