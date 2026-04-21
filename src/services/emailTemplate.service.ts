import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";

// ============================================================================
// EMAIL TEMPLATES SERVICE
// Reusable templates with {{variable}} substitution
// ============================================================================

export interface CreateTemplateDto {
  name: string;
  description?: string;
  category?: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  variables?: string[];
  isShared?: boolean;
}

export type UpdateTemplateDto = Partial<CreateTemplateDto>;

const CATEGORIES = [
  "general",
  "welcome",
  "follow_up",
  "promotional",
  "transactional",
  "reminder",
  "announcement",
];

function extractVariables(html: string, subject: string): string[] {
  const all = `${subject}\n${html}`;
  const matches = all.match(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g) || [];
  const vars = new Set<string>();
  for (const m of matches) {
    const name = m.replace(/[\{\}\s]/g, "");
    vars.add(name);
  }
  return Array.from(vars);
}

export async function listTemplates(
  companyId: string,
  userId: string,
  category?: string
) {
  const where: any = {
    companyId,
    OR: [{ isShared: true }, { createdById: userId }],
  };
  if (category) where.category = category;

  return prisma.emailTemplate.findMany({
    where,
    orderBy: [{ usageCount: "desc" }, { updatedAt: "desc" }],
    include: {
      createdBy: { select: { id: true, fullName: true } },
    },
  });
}

export async function getTemplate(
  companyId: string,
  userId: string,
  id: string
) {
  const template = await prisma.emailTemplate.findFirst({
    where: {
      id,
      companyId,
      OR: [{ isShared: true }, { createdById: userId }],
    },
    include: { createdBy: { select: { id: true, fullName: true } } },
  });
  if (!template) throw notFound("Template");
  return template;
}

export async function createTemplate(
  companyId: string,
  userId: string,
  dto: CreateTemplateDto
) {
  const variables =
    dto.variables && dto.variables.length > 0
      ? dto.variables
      : extractVariables(dto.bodyHtml, dto.subject);

  return prisma.emailTemplate.create({
    data: {
      companyId,
      createdById: userId,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      category: dto.category || "general",
      subject: dto.subject,
      bodyHtml: dto.bodyHtml,
      bodyText: dto.bodyText || null,
      variables,
      isShared: dto.isShared ?? true,
    },
    include: { createdBy: { select: { id: true, fullName: true } } },
  });
}

export async function updateTemplate(
  companyId: string,
  userId: string,
  id: string,
  dto: UpdateTemplateDto
) {
  const existing = await prisma.emailTemplate.findFirst({
    where: { id, companyId },
    select: { id: true, createdById: true, isShared: true },
  });
  if (!existing) throw notFound("Template");

  // Non-creator can only update their own private templates
  if (!existing.isShared && existing.createdById !== userId) {
    const err: any = new Error("Not allowed");
    err.statusCode = 403;
    throw err;
  }

  const data: any = {};
  if (dto.name !== undefined) data.name = dto.name.trim();
  if (dto.description !== undefined) data.description = dto.description?.trim() || null;
  if (dto.category !== undefined) data.category = dto.category;
  if (dto.subject !== undefined) data.subject = dto.subject;
  if (dto.bodyHtml !== undefined) data.bodyHtml = dto.bodyHtml;
  if (dto.bodyText !== undefined) data.bodyText = dto.bodyText;
  if (dto.isShared !== undefined) data.isShared = dto.isShared;

  if (dto.bodyHtml !== undefined || dto.subject !== undefined) {
    data.variables = extractVariables(
      dto.bodyHtml ?? "",
      dto.subject ?? ""
    );
  }

  return prisma.emailTemplate.update({
    where: { id },
    data,
    include: { createdBy: { select: { id: true, fullName: true } } },
  });
}

export async function deleteTemplate(
  companyId: string,
  userId: string,
  id: string
) {
  const existing = await prisma.emailTemplate.findFirst({
    where: { id, companyId },
    select: { id: true, createdById: true },
  });
  if (!existing) throw notFound("Template");
  if (existing.createdById !== userId) {
    const err: any = new Error("Only the creator can delete a template");
    err.statusCode = 403;
    throw err;
  }
  await prisma.emailTemplate.delete({ where: { id } });
  return { deleted: true };
}

// Render a template with given variables — used when sending
export function renderTemplate(
  bodyHtml: string,
  subject: string,
  variables: Record<string, string | number>
): { subject: string; bodyHtml: string } {
  const render = (text: string) =>
    text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
      const value = variables[key];
      if (value === undefined || value === null) return "";
      return String(value);
    });

  return { subject: render(subject), bodyHtml: render(bodyHtml) };
}

export async function incrementUsage(companyId: string, id: string) {
  await prisma.emailTemplate.updateMany({
    where: { id, companyId },
    data: { usageCount: { increment: 1 } },
  });
}

export { CATEGORIES };
