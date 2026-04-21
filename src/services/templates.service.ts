// ============================================================================
// TEMPLATES MARKETPLACE SERVICE
// ----------------------------------------------------------------------------
// Lists curated industry-specific templates and applies them to a company
// workspace in one transaction. Each apply records a TemplateApplication
// with the IDs of every record created, so an Undo action can remove
// exactly what was planted and not touch user-created data that came after.
// ============================================================================

import { prisma } from "../config/database";
import { notFound, AppError } from "../middleware/errorHandler";

interface TemplateBundle {
  pipelineStages?: string[];
  tags?: string[];
  customerStatuses?: string[];
  dealSources?: string[];
  customFields?: Array<{
    entityType: string;
    name: string;
    slug: string;
    type: string;
    options?: string[];
  }>;
  emailTemplates?: Array<{
    subject: string;
    body: string;
    purpose?: string;
  }>;
  quoteTemplate?: {
    title: string;
    items: Array<{ description: string; quantity: number; price: number }>;
    terms: string;
  };
  seedCustomers?: Array<{
    fullName: string;
    email?: string;
    phone?: string;
    companyName?: string;
    status?: string;
    tags?: string[];
    source?: string;
  }>;
  seedDeals?: Array<{
    title: string;
    value: number;
    currency: string;
    stage: string;
    customerIdx: number;  // 0-based index into seedCustomers
  }>;
}

// ──────────────────────────────────────────────────────────────────────
// LIST — catalog for browse UI
// ──────────────────────────────────────────────────────────────────────

export async function listTemplates(filters?: {
  industry?: string;
  region?: string;
}) {
  // Using raw SQL to avoid Prisma client regen (same pattern as
  // dashboard-layout.service). Keeps deploys unblocked in a container
  // that can't reach the Prisma engine CDN.
  const conditions: string[] = [`"isActive" = true`];
  const params: (string | number)[] = [];
  if (filters?.industry) {
    params.push(filters.industry);
    conditions.push(`"industry" = $${params.length}`);
  }
  if (filters?.region) {
    params.push(filters.region);
    conditions.push(`"region" = $${params.length}`);
  }
  const sql = `
    SELECT
      id, slug, industry, region, locale,
      name, "nameAr", "nameTr",
      tagline, "taglineAr", "taglineTr",
      description, "descriptionAr", "descriptionTr",
      icon, color, "isFeatured", "sortOrder", "setupMinutes",
      (bundle->>'seedCustomers' IS NOT NULL) AS "hasSeedData"
    FROM templates
    WHERE ${conditions.join(" AND ")}
    ORDER BY "isFeatured" DESC, "sortOrder" ASC, name ASC
  `;
  return prisma.$queryRawUnsafe(sql, ...params);
}

export async function getTemplate(slug: string) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM templates WHERE slug = $1 AND "isActive" = true LIMIT 1`,
    slug
  )) as any[];
  if (rows.length === 0) throw notFound("Template not found");
  return rows[0];
}

// ──────────────────────────────────────────────────────────────────────
// APPLY — the core operation
// ──────────────────────────────────────────────────────────────────────

export async function applyTemplate(
  companyId: string,
  userId: string,
  templateSlug: string
): Promise<{
  applicationId: string;
  summary: { [key: string]: number };
}> {
  const template = await getTemplate(templateSlug);
  const bundle: TemplateBundle =
    typeof template.bundle === "string"
      ? JSON.parse(template.bundle)
      : template.bundle;

  // Track what we create so Undo can remove exactly this set.
  const created: {
    tags: string[];
    customers: string[];
    deals: string[];
    customFields: string[];
    emailTemplates: string[];
  } = {
    tags: [],
    customers: [],
    deals: [],
    customFields: [],
    emailTemplates: [],
  };

  try {
    // Apply in a transaction so a partial failure doesn't leave half-
    // planted data the user would have to clean up by hand.
    await prisma.$transaction(async (tx) => {
      // --- TAGS -----------------------------------------------------
      if (bundle.tags && bundle.tags.length > 0) {
        for (const tagName of bundle.tags) {
          const rows = (await tx.$queryRawUnsafe(
            `INSERT INTO tags (id, "companyId", name, "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
             ON CONFLICT DO NOTHING
             RETURNING id`,
            companyId,
            tagName
          )) as { id: string }[];
          if (rows.length > 0) created.tags.push(rows[0].id);
        }
      }

      // --- CUSTOM FIELDS --------------------------------------------
      if (bundle.customFields && bundle.customFields.length > 0) {
        for (const cf of bundle.customFields) {
          const rows = (await tx.$queryRawUnsafe(
            `INSERT INTO custom_fields
               (id, "companyId", "entityType", "fieldKey", label, "fieldType", options, "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW())
             ON CONFLICT DO NOTHING
             RETURNING id`,
            companyId,
            cf.entityType,
            cf.slug,     // fieldKey
            cf.name,     // label
            cf.type,     // fieldType
            JSON.stringify(cf.options ?? [])
          )) as { id: string }[];
          if (rows.length > 0) created.customFields.push(rows[0].id);
        }
      }

      // --- EMAIL TEMPLATES ------------------------------------------
      if (bundle.emailTemplates && bundle.emailTemplates.length > 0) {
        for (const et of bundle.emailTemplates) {
          const rows = (await tx.$queryRawUnsafe(
            `INSERT INTO email_templates
               (id, "companyId", "createdById", name, category, subject, "bodyHtml",
                "isActive", "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, true, NOW(), NOW())
             RETURNING id`,
            companyId,
            userId,
            et.purpose ?? et.subject.slice(0, 60),  // name
            et.purpose ?? "general",
            et.subject,
            et.body
          )) as { id: string }[];
          if (rows.length > 0) created.emailTemplates.push(rows[0].id);
        }
      }

      // --- SEED CUSTOMERS -------------------------------------------
      // Track customer index → id so seed deals can link them.
      const customerIds: string[] = [];
      if (bundle.seedCustomers && bundle.seedCustomers.length > 0) {
        for (const c of bundle.seedCustomers) {
          const rows = (await tx.$queryRawUnsafe(
            `INSERT INTO customers
               (id, "companyId", "fullName", email, phone, "companyName",
                status, source, "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
             RETURNING id`,
            companyId,
            c.fullName,
            c.email ?? null,
            c.phone ?? null,
            c.companyName ?? null,
            c.status ?? "new",
            c.source ?? "template"
          )) as { id: string }[];
          if (rows.length > 0) {
            customerIds.push(rows[0].id);
            created.customers.push(rows[0].id);
          }
        }
      }

      // --- SEED DEALS -----------------------------------------------
      if (bundle.seedDeals && bundle.seedDeals.length > 0) {
        for (const d of bundle.seedDeals) {
          const custId = customerIds[d.customerIdx];
          if (!custId) continue; // skip if index out of range
          const rows = (await tx.$queryRawUnsafe(
            `INSERT INTO deals
               (id, "companyId", "customerId", title, value, currency,
                stage, "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), NOW())
             RETURNING id`,
            companyId,
            custId,
            d.title,
            d.value,
            d.currency,
            d.stage
          )) as { id: string }[];
          if (rows.length > 0) created.deals.push(rows[0].id);
        }
      }

      // --- RECORD THE APPLICATION ----------------------------------
      await tx.$executeRawUnsafe(
        `INSERT INTO template_applications
           (id, "templateId", "companyId", "userId", "createdRecords",
            status, "appliedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, 'completed', NOW())`,
        template.id,
        companyId,
        userId,
        JSON.stringify(created)
      );
    });
  } catch (err) {
    // Record a failed application so we can see it in ops
    await prisma.$executeRawUnsafe(
      `INSERT INTO template_applications
         (id, "templateId", "companyId", "userId", "createdRecords",
          status, "errorMessage", "appliedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, '{}'::jsonb, 'failed', $4, NOW())`,
      template.id,
      companyId,
      userId,
      (err as Error).message.slice(0, 500)
    );
    throw new AppError(
      "Failed to apply template — no changes were made.",
      500,
      "TEMPLATE_APPLY_FAILED"
    );
  }

  // Get the application ID we just inserted (inside the tx above)
  const apps = (await prisma.$queryRawUnsafe(
    `SELECT id FROM template_applications
     WHERE "companyId" = $1 AND "templateId" = $2
     ORDER BY "appliedAt" DESC LIMIT 1`,
    companyId,
    template.id
  )) as { id: string }[];

  return {
    applicationId: apps[0]?.id ?? "",
    summary: {
      tags: created.tags.length,
      customFields: created.customFields.length,
      emailTemplates: created.emailTemplates.length,
      customers: created.customers.length,
      deals: created.deals.length,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// APPLICATIONS HISTORY — what this company has applied
// ──────────────────────────────────────────────────────────────────────

export async function listCompanyApplications(companyId: string) {
  return prisma.$queryRawUnsafe(
    `SELECT
       ta.id, ta."templateId", ta."appliedAt", ta.status,
       ta."createdRecords",
       t.slug, t.name, t."nameAr", t."nameTr", t.icon, t.industry
     FROM template_applications ta
     JOIN templates t ON t.id = ta."templateId"
     WHERE ta."companyId" = $1
     ORDER BY ta."appliedAt" DESC
     LIMIT 50`,
    companyId
  );
}

// ──────────────────────────────────────────────────────────────────────
// REVERT — delete records created by a specific application
// ──────────────────────────────────────────────────────────────────────

export async function revertApplication(
  companyId: string,
  applicationId: string
) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "createdRecords", status FROM template_applications
     WHERE id = $1 AND "companyId" = $2 LIMIT 1`,
    applicationId,
    companyId
  )) as { createdRecords: any; status: string }[];

  if (rows.length === 0) throw notFound("Application not found");
  if (rows[0].status === "reverted") {
    throw new AppError(
      "This application is already reverted.",
      400,
      "ALREADY_REVERTED"
    );
  }

  const records = rows[0].createdRecords as {
    tags?: string[];
    customers?: string[];
    deals?: string[];
    customFields?: string[];
    emailTemplates?: string[];
  };

  await prisma.$transaction(async (tx) => {
    // Order matters — delete deals before customers so FK doesn't
    // complain, and customers before tags in case tag relations exist.
    if (records.deals && records.deals.length > 0) {
      await tx.$executeRawUnsafe(
        `DELETE FROM deals WHERE id = ANY($1::text[]) AND "companyId" = $2`,
        records.deals,
        companyId
      );
    }
    if (records.customers && records.customers.length > 0) {
      await tx.$executeRawUnsafe(
        `DELETE FROM customers WHERE id = ANY($1::text[]) AND "companyId" = $2`,
        records.customers,
        companyId
      );
    }
    if (records.emailTemplates && records.emailTemplates.length > 0) {
      await tx.$executeRawUnsafe(
        `DELETE FROM email_templates WHERE id = ANY($1::text[]) AND "companyId" = $2`,
        records.emailTemplates,
        companyId
      );
    }
    if (records.customFields && records.customFields.length > 0) {
      await tx.$executeRawUnsafe(
        `DELETE FROM custom_fields WHERE id = ANY($1::text[]) AND "companyId" = $2`,
        records.customFields,
        companyId
      );
    }
    if (records.tags && records.tags.length > 0) {
      await tx.$executeRawUnsafe(
        `DELETE FROM tags WHERE id = ANY($1::text[]) AND "companyId" = $2`,
        records.tags,
        companyId
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE template_applications SET status = 'reverted'
       WHERE id = $1 AND "companyId" = $2`,
      applicationId,
      companyId
    );
  });

  return { reverted: true };
}
