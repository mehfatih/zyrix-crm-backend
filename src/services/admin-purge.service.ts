// ============================================================================
// ADMIN — PERMANENT TENANT PURGE (hard delete)
// ----------------------------------------------------------------------------
// Irreversibly deletes a tenant and ALL its data. Two-step safety: a tenant
// MUST already be soft-deleted (deletedAt set) before it can be purged.
//
// 102 tables carry a companyId; only 43 cascade on a company-row delete, so we
// can't rely on the FK cascade alone. Instead we discover every tenant table +
// the FK graph from information_schema, topologically sort it (children before
// parents), delete each WHERE companyId=$1 in that order inside a transaction,
// drop the company row, then VERIFY zero rows remain across all tenant tables —
// aborting (rollback) if any leftover, so a future un-cascaded table can never
// silently orphan data.
// ============================================================================

import { prisma } from "../config/database";
import { badRequest, notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";

const PROTECTED_SLUGS = new Set(["zyrix-system"]);

/** All public tables that carry a companyId column (the tenant-scoped set). */
async function tenantTables(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.columns
     WHERE column_name = 'companyId' AND table_schema = 'public'
     ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

/** FK edges [child, parent] where both endpoints are tenant tables. */
async function fkEdges(tables: Set<string>): Promise<Array<[string, string]>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ child: string; parent: string }>>(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
     FROM information_schema.table_constraints tc
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`
  );
  const edges: Array<[string, string]> = [];
  for (const r of rows) {
    if (tables.has(r.child) && tables.has(r.parent) && r.child !== r.parent) edges.push([r.child, r.parent]);
  }
  return edges;
}

/** Topological order: a referencing (child) table comes before the table it references (parent). */
function topoChildrenFirst(nodes: string[], edges: Array<[string, string]>): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) { indeg.set(n, 0); adj.set(n, []); }
  for (const [child, parent] of edges) {
    adj.get(child)!.push(parent);
    indeg.set(parent, (indeg.get(parent) ?? 0) + 1);
  }
  const queue = nodes.filter((n) => (indeg.get(n) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of adj.get(n) ?? []) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if ((indeg.get(m) ?? 0) === 0) queue.push(m);
    }
  }
  // Any nodes left are in an FK cycle — append in stable order; the post-delete
  // verify will catch genuine leftovers.
  for (const n of nodes) if (!order.includes(n)) order.push(n);
  return order;
}

export interface PurgeResult {
  id: string;
  purged: true;
  totalRows: number;
  deletedTables: Record<string, number>;
}

export async function purgeCompanyPermanently(
  companyId: string,
  actorUserId: string,
  confirmName: string
): Promise<PurgeResult> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw notFound("Company");
  if (PROTECTED_SLUGS.has(company.slug)) throw badRequest("Cannot permanently delete the system company");
  if (!company.deletedAt) throw badRequest("Soft-delete the tenant first, then delete permanently");
  if ((confirmName ?? "").trim() !== company.name) throw badRequest("Confirmation name does not match the company name");

  const tables = await tenantTables();
  const order = topoChildrenFirst(tables, await fkEdges(new Set(tables)));

  const deletedTables: Record<string, number> = {};
  await prisma.$transaction(
    async (tx) => {
      for (const t of order) {
        const n = await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "companyId" = $1`, companyId);
        if (n > 0) deletedTables[t] = n;
      }
      await tx.$executeRawUnsafe(`DELETE FROM "companies" WHERE "id" = $1`, companyId);
      // Verify the tenant is fully gone — abort (rollback) on any leftover.
      for (const t of tables) {
        const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${t}" WHERE "companyId" = $1`, companyId);
        if (rows[0].n > 0) throw new Error(`Purge incomplete: ${rows[0].n} row(s) remain in "${t}"`);
      }
    },
    { timeout: 120_000, maxWait: 20_000 }
  );

  const totalRows = Object.values(deletedTables).reduce((a, b) => a + b, 0);

  // Audit AFTER commit. companyId is left null (the FK target is gone); the id
  // + name live in metadata for the trail.
  try {
    await prisma.auditLog.create({
      data: {
        userId: actorUserId,
        action: "company.purge",
        entityType: "company",
        entityId: companyId,
        companyId: null,
        metadata: {
          companyName: company.name,
          slug: company.slug,
          plan: company.plan,
          totalRows,
          deletedTables,
        } as Prisma.InputJsonValue,
      },
    });
  } catch {
    // non-critical
  }

  return { id: companyId, purged: true, totalRows, deletedTables };
}
