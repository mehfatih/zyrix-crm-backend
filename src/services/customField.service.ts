import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";

// ============================================================================
// CUSTOM FIELDS SERVICE
// Company-defined schema extensions for customers + deals
// ============================================================================

export type EntityType = "customer" | "deal";
export type FieldType =
  | "text"
  | "number"
  | "date"
  | "select"
  | "multi_select"
  | "boolean"
  | "url"
  | "email";

export interface CreateFieldDto {
  entityType: EntityType;
  fieldKey: string;
  label: string;
  fieldType: FieldType;
  options?: string[];
  required?: boolean;
  defaultValue?: string;
  position?: number;
}

export type UpdateFieldDto = Partial<CreateFieldDto> & {
  isActive?: boolean;
};

export async function listFields(
  companyId: string,
  entityType?: EntityType
) {
  const where: any = { companyId, isActive: true };
  if (entityType) where.entityType = entityType;

  return prisma.customField.findMany({
    where,
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}

export async function createField(
  companyId: string,
  dto: CreateFieldDto
) {
  // Sanitize key
  const fieldKey = dto.fieldKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  if (!fieldKey) {
    const err: any = new Error("Invalid field key");
    err.statusCode = 400;
    throw err;
  }

  // Check for duplicate
  const existing = await prisma.customField.findUnique({
    where: {
      companyId_entityType_fieldKey: {
        companyId,
        entityType: dto.entityType,
        fieldKey,
      },
    },
  });
  if (existing) {
    const err: any = new Error(
      `Field "${fieldKey}" already exists for this entity`
    );
    err.statusCode = 409;
    throw err;
  }

  return prisma.customField.create({
    data: {
      companyId,
      entityType: dto.entityType,
      fieldKey,
      label: dto.label.trim(),
      fieldType: dto.fieldType,
      options:
        dto.fieldType === "select" || dto.fieldType === "multi_select"
          ? dto.options || []
          : undefined,
      required: dto.required ?? false,
      defaultValue: dto.defaultValue || null,
      position: dto.position ?? 0,
    },
  });
}

export async function updateField(
  companyId: string,
  id: string,
  dto: UpdateFieldDto
) {
  const existing = await prisma.customField.findFirst({
    where: { id, companyId },
  });
  if (!existing) throw notFound("Custom field");

  const data: any = {};
  if (dto.label !== undefined) data.label = dto.label.trim();
  if (dto.fieldType !== undefined) data.fieldType = dto.fieldType;
  if (dto.options !== undefined) data.options = dto.options;
  if (dto.required !== undefined) data.required = dto.required;
  if (dto.defaultValue !== undefined)
    data.defaultValue = dto.defaultValue || null;
  if (dto.position !== undefined) data.position = dto.position;
  if (dto.isActive !== undefined) data.isActive = dto.isActive;

  return prisma.customField.update({ where: { id }, data });
}

export async function deleteField(companyId: string, id: string) {
  const existing = await prisma.customField.findFirst({
    where: { id, companyId },
    select: { id: true },
  });
  if (!existing) throw notFound("Custom field");
  await prisma.customField.delete({ where: { id } });
  return { deleted: true };
}

// Validate custom field values against field schema
export async function validateCustomFields(
  companyId: string,
  entityType: EntityType,
  values: Record<string, any>
): Promise<Record<string, any>> {
  const fields = await prisma.customField.findMany({
    where: { companyId, entityType, isActive: true },
  });

  const result: Record<string, any> = {};
  for (const field of fields) {
    const value = values[field.fieldKey];
    if (value === undefined || value === null || value === "") {
      if (field.required) {
        const err: any = new Error(`Field "${field.label}" is required`);
        err.statusCode = 400;
        throw err;
      }
      continue;
    }

    // Coerce types
    switch (field.fieldType) {
      case "number":
        const n = Number(value);
        if (isNaN(n)) {
          const err: any = new Error(
            `Field "${field.label}" must be a number`
          );
          err.statusCode = 400;
          throw err;
        }
        result[field.fieldKey] = n;
        break;
      case "boolean":
        result[field.fieldKey] = Boolean(value);
        break;
      case "date":
        result[field.fieldKey] = new Date(value).toISOString();
        break;
      case "select":
        const options = (field.options as string[]) || [];
        if (options.length > 0 && !options.includes(String(value))) {
          const err: any = new Error(
            `Invalid value for "${field.label}"`
          );
          err.statusCode = 400;
          throw err;
        }
        result[field.fieldKey] = String(value);
        break;
      case "multi_select":
        const arr = Array.isArray(value) ? value : [value];
        result[field.fieldKey] = arr.map((v) => String(v));
        break;
      default:
        result[field.fieldKey] = String(value);
    }
  }

  return result;
}
