import { prisma } from "../config/database";

// ============================================================================
// BULK ACTIONS SERVICE
// Mass operations on customers + deals
// ============================================================================

export type BulkEntityType = "customers" | "deals";

export type BulkAction =
  | "delete"
  | "assignOwner"
  | "changeStatus"
  | "addTag"
  | "removeTag"
  | "changeStage";

export interface BulkActionDto {
  entityType: BulkEntityType;
  action: BulkAction;
  ids: string[];
  params?: {
    ownerId?: string;
    status?: string;
    stage?: string;
    tagId?: string;
  };
}

export interface BulkActionResult {
  action: BulkAction;
  entityType: BulkEntityType;
  total: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

// Validate all IDs belong to the company first
async function assertOwnership(
  companyId: string,
  entityType: BulkEntityType,
  ids: string[]
): Promise<string[]> {
  if (entityType === "customers") {
    const found = await prisma.customer.findMany({
      where: { id: { in: ids }, companyId },
      select: { id: true },
    });
    return found.map((f) => f.id);
  } else {
    const found = await prisma.deal.findMany({
      where: { id: { in: ids }, companyId },
      select: { id: true },
    });
    return found.map((f) => f.id);
  }
}

export async function bulkAction(
  companyId: string,
  dto: BulkActionDto
): Promise<BulkActionResult> {
  const result: BulkActionResult = {
    action: dto.action,
    entityType: dto.entityType,
    total: dto.ids.length,
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  if (dto.ids.length === 0) return result;
  if (dto.ids.length > 500) {
    const err: any = new Error(
      "Too many items. Maximum 500 per bulk action."
    );
    err.statusCode = 400;
    throw err;
  }

  const validIds = await assertOwnership(
    companyId,
    dto.entityType,
    dto.ids
  );
  result.failed = dto.ids.length - validIds.length;
  if (result.failed > 0) {
    result.errors.push(
      `${result.failed} items not found or not accessible`
    );
  }

  if (validIds.length === 0) return result;

  // Apply action
  try {
    if (dto.action === "delete") {
      if (dto.entityType === "customers") {
        const r = await prisma.customer.deleteMany({
          where: { id: { in: validIds }, companyId },
        });
        result.succeeded = r.count;
      } else {
        const r = await prisma.deal.deleteMany({
          where: { id: { in: validIds }, companyId },
        });
        result.succeeded = r.count;
      }
    } else if (dto.action === "assignOwner") {
      if (!dto.params?.ownerId) {
        const err: any = new Error("ownerId required");
        err.statusCode = 400;
        throw err;
      }
      // Validate owner belongs to company
      const owner = await prisma.user.findFirst({
        where: { id: dto.params.ownerId, companyId },
        select: { id: true },
      });
      if (!owner) {
        const err: any = new Error("Owner not found in company");
        err.statusCode = 400;
        throw err;
      }

      if (dto.entityType === "customers") {
        const r = await prisma.customer.updateMany({
          where: { id: { in: validIds }, companyId },
          data: { ownerId: dto.params.ownerId },
        });
        result.succeeded = r.count;
      } else {
        const r = await prisma.deal.updateMany({
          where: { id: { in: validIds }, companyId },
          data: { ownerId: dto.params.ownerId },
        });
        result.succeeded = r.count;
      }
    } else if (dto.action === "changeStatus") {
      if (!dto.params?.status) {
        const err: any = new Error("status required");
        err.statusCode = 400;
        throw err;
      }
      if (dto.entityType === "customers") {
        const r = await prisma.customer.updateMany({
          where: { id: { in: validIds }, companyId },
          data: { status: dto.params.status },
        });
        result.succeeded = r.count;
      } else {
        result.errors.push("changeStatus only applies to customers");
      }
    } else if (dto.action === "changeStage") {
      if (!dto.params?.stage) {
        const err: any = new Error("stage required");
        err.statusCode = 400;
        throw err;
      }
      if (dto.entityType === "deals") {
        const r = await prisma.deal.updateMany({
          where: { id: { in: validIds }, companyId },
          data: { stage: dto.params.stage },
        });
        result.succeeded = r.count;
      } else {
        result.errors.push("changeStage only applies to deals");
      }
    } else if (dto.action === "addTag") {
      if (!dto.params?.tagId) {
        const err: any = new Error("tagId required");
        err.statusCode = 400;
        throw err;
      }
      if (dto.entityType === "customers") {
        // Validate tag
        const tag = await prisma.tag.findFirst({
          where: { id: dto.params.tagId, companyId },
          select: { id: true },
        });
        if (!tag) {
          const err: any = new Error("Tag not found");
          err.statusCode = 400;
          throw err;
        }
        // Create tag associations, skipping duplicates
        const rows = validIds.map((cid) => ({
          customerId: cid,
          tagId: dto.params!.tagId!,
        }));
        const r = await prisma.customerTag.createMany({
          data: rows,
          skipDuplicates: true,
        });
        result.succeeded = r.count;
      } else {
        result.errors.push("addTag only applies to customers");
      }
    } else if (dto.action === "removeTag") {
      if (!dto.params?.tagId) {
        const err: any = new Error("tagId required");
        err.statusCode = 400;
        throw err;
      }
      if (dto.entityType === "customers") {
        const r = await prisma.customerTag.deleteMany({
          where: {
            customerId: { in: validIds },
            tagId: dto.params.tagId,
          },
        });
        result.succeeded = r.count;
      } else {
        result.errors.push("removeTag only applies to customers");
      }
    }
  } catch (e: any) {
    result.errors.push(e.message || "Bulk action failed");
    if (e.statusCode) throw e;
  }

  return result;
}
