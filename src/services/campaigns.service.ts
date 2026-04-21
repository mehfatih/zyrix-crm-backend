import { prisma } from "../config/database";
import { notFound } from "../middleware/errorHandler";
import type { Prisma } from "@prisma/client";
import { sendEmail } from "./email.service";

// ============================================================================
// CAMPAIGNS SERVICE (Marketing Automation + Email Marketing)
// ============================================================================

export type Channel = "email" | "whatsapp" | "sms";
export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled";
export type TargetType = "all" | "status" | "tag" | "manual";

export interface CreateCampaignDto {
  name: string;
  subject?: string;
  channel: Channel;
  bodyHtml?: string;
  bodyText?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  targetType?: TargetType;
  targetValue?: string;
  scheduledAt?: Date | null;
  customerIds?: string[];
}

export interface UpdateCampaignDto extends Partial<CreateCampaignDto> {}

// ─────────────────────────────────────────────────────────────────────────
// AUDIENCE RESOLVER
// ─────────────────────────────────────────────────────────────────────────
async function resolveAudience(
  companyId: string,
  targetType: TargetType,
  targetValue: string | null,
  customerIds?: string[]
) {
  if (targetType === "manual" && customerIds && customerIds.length > 0) {
    return prisma.customer.findMany({
      where: { id: { in: customerIds }, companyId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        whatsappPhone: true,
      },
    });
  }

  const where: Prisma.CustomerWhereInput = {
    companyId,
    status: { notIn: ["lost", "disabled"] },
  };

  if (targetType === "status" && targetValue) {
    where.status = targetValue;
  }
  if (targetType === "tag" && targetValue) {
    where.tags = { some: { tag: { name: targetValue } } };
  }

  return prisma.customer.findMany({
    where,
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      whatsappPhone: true,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────
export async function listCampaigns(
  companyId: string,
  q: {
    status?: CampaignStatus;
    channel?: Channel;
    page?: number;
    limit?: number;
  } = {}
) {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 50));
  const skip = (page - 1) * limit;

  const where: Prisma.CampaignWhereInput = { companyId };
  if (q.status) where.status = q.status;
  if (q.channel) where.channel = q.channel;

  const [total, items] = await Promise.all([
    prisma.campaign.count({ where }),
    prisma.campaign.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        createdBy: { select: { id: true, fullName: true, email: true } },
      },
    }),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getCampaign(companyId: string, id: string) {
  const c = await prisma.campaign.findFirst({
    where: { id, companyId },
    include: {
      createdBy: { select: { id: true, fullName: true, email: true } },
      recipients: {
        orderBy: { createdAt: "asc" },
        take: 100,
        include: {
          customer: {
            select: { id: true, fullName: true, email: true, companyName: true },
          },
        },
      },
    },
  });
  if (!c) throw notFound("Campaign");
  return c;
}

export async function createCampaign(
  companyId: string,
  userId: string,
  dto: CreateCampaignDto
) {
  // Resolve audience & precompute recipient count
  const audience = await resolveAudience(
    companyId,
    dto.targetType ?? "all",
    dto.targetValue ?? null,
    dto.customerIds
  );

  const channel = dto.channel;
  const eligible = audience.filter((a) => {
    if (channel === "email") return !!a.email;
    if (channel === "whatsapp") return !!(a.whatsappPhone || a.phone);
    if (channel === "sms") return !!a.phone;
    return false;
  });

  const created = await prisma.campaign.create({
    data: {
      companyId,
      createdById: userId,
      name: dto.name.trim(),
      subject: dto.subject?.trim() || null,
      channel,
      status: dto.scheduledAt ? "scheduled" : "draft",
      bodyHtml: dto.bodyHtml ?? null,
      bodyText: dto.bodyText ?? null,
      fromName: dto.fromName?.trim() || null,
      fromEmail: dto.fromEmail?.trim() || null,
      replyTo: dto.replyTo?.trim() || null,
      targetType: dto.targetType ?? "all",
      targetValue: dto.targetValue?.trim() || null,
      scheduledAt: dto.scheduledAt ?? null,
      recipientCount: eligible.length,
      recipients: {
        create: eligible.map((c) => ({
          customerId: c.id,
          email: c.email ?? null,
          phone: channel === "whatsapp" ? c.whatsappPhone ?? c.phone ?? null : c.phone ?? null,
          status: "queued",
        })),
      },
    },
    include: {
      createdBy: { select: { id: true, fullName: true, email: true } },
    },
  });

  return created;
}

export async function updateCampaign(
  companyId: string,
  id: string,
  dto: UpdateCampaignDto
) {
  const existing = await prisma.campaign.findFirst({
    where: { id, companyId },
  });
  if (!existing) throw notFound("Campaign");
  if (existing.status === "sent" || existing.status === "sending") {
    const err: any = new Error("Cannot edit a sent or sending campaign");
    err.statusCode = 400;
    throw err;
  }

  const data: Prisma.CampaignUpdateInput = {};
  if (dto.name !== undefined) data.name = dto.name.trim();
  if (dto.subject !== undefined) data.subject = dto.subject?.trim() || null;
  if (dto.bodyHtml !== undefined) data.bodyHtml = dto.bodyHtml;
  if (dto.bodyText !== undefined) data.bodyText = dto.bodyText;
  if (dto.fromName !== undefined) data.fromName = dto.fromName?.trim() || null;
  if (dto.fromEmail !== undefined)
    data.fromEmail = dto.fromEmail?.trim() || null;
  if (dto.replyTo !== undefined) data.replyTo = dto.replyTo?.trim() || null;
  if (dto.scheduledAt !== undefined) {
    data.scheduledAt = dto.scheduledAt;
    if (dto.scheduledAt && existing.status === "draft") data.status = "scheduled";
    if (!dto.scheduledAt && existing.status === "scheduled") data.status = "draft";
  }

  // If audience changes, rebuild recipient list
  const rebuild =
    dto.targetType !== undefined ||
    dto.targetValue !== undefined ||
    dto.customerIds !== undefined ||
    dto.channel !== undefined;

  if (rebuild) {
    const targetType = dto.targetType ?? (existing.targetType as TargetType);
    const targetValue = dto.targetValue ?? existing.targetValue ?? null;
    const channel = dto.channel ?? (existing.channel as Channel);
    const audience = await resolveAudience(
      companyId,
      targetType,
      targetValue,
      dto.customerIds
    );
    const eligible = audience.filter((a) => {
      if (channel === "email") return !!a.email;
      if (channel === "whatsapp") return !!(a.whatsappPhone || a.phone);
      if (channel === "sms") return !!a.phone;
      return false;
    });

    await prisma.$transaction([
      prisma.campaignRecipient.deleteMany({ where: { campaignId: id } }),
      prisma.campaignRecipient.createMany({
        data: eligible.map((c) => ({
          campaignId: id,
          customerId: c.id,
          email: c.email ?? null,
          phone:
            channel === "whatsapp"
              ? c.whatsappPhone ?? c.phone ?? null
              : c.phone ?? null,
          status: "queued",
        })),
      }),
    ]);

    data.recipientCount = eligible.length;
    if (dto.channel !== undefined) data.channel = dto.channel;
    if (dto.targetType !== undefined) data.targetType = dto.targetType;
    if (dto.targetValue !== undefined)
      data.targetValue = dto.targetValue?.trim() || null;
  }

  return prisma.campaign.update({
    where: { id },
    data,
    include: {
      createdBy: { select: { id: true, fullName: true, email: true } },
    },
  });
}

export async function deleteCampaign(companyId: string, id: string) {
  const existing = await prisma.campaign.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!existing) throw notFound("Campaign");
  if (existing.status === "sending") {
    const err: any = new Error("Cannot delete a campaign currently sending");
    err.statusCode = 400;
    throw err;
  }
  await prisma.campaign.delete({ where: { id } });
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// SEND NOW (synchronous dispatch — in real prod use queue)
// ─────────────────────────────────────────────────────────────────────────
export async function sendCampaign(companyId: string, id: string) {
  const campaign = await prisma.campaign.findFirst({
    where: { id, companyId },
    include: { recipients: true, company: { select: { name: true } } },
  });
  if (!campaign) throw notFound("Campaign");
  if (campaign.status === "sent" || campaign.status === "sending") {
    const err: any = new Error(`Campaign already ${campaign.status}`);
    err.statusCode = 400;
    throw err;
  }
  if (!campaign.recipients.length) {
    const err: any = new Error("No recipients to send to");
    err.statusCode = 400;
    throw err;
  }

  await prisma.campaign.update({
    where: { id },
    data: { status: "sending" },
  });

  let sent = 0;
  let failed = 0;

  // For WhatsApp/SMS: placeholder only — mark as sent but not actually delivered
  if (campaign.channel === "email") {
    for (const r of campaign.recipients) {
      if (!r.email) {
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { status: "failed", errorMessage: "No email on file" },
        });
        failed++;
        continue;
      }
      try {
        const ok = await sendEmail({
          to: r.email,
          subject: campaign.subject ?? campaign.name,
          html:
            campaign.bodyHtml ??
            `<p>${(campaign.bodyText ?? "").replace(/\n/g, "<br>")}</p>`,
          text: campaign.bodyText ?? undefined,
        });
        if (ok) {
          await prisma.campaignRecipient.update({
            where: { id: r.id },
            data: { status: "sent", sentAt: new Date() },
          });
          sent++;
        } else {
          await prisma.campaignRecipient.update({
            where: { id: r.id },
            data: {
              status: "failed",
              errorMessage: "Resend returned error",
            },
          });
          failed++;
        }
      } catch (e: any) {
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: {
            status: "failed",
            errorMessage: e?.message ?? "Unknown error",
          },
        });
        failed++;
      }
    }
  } else {
    // WhatsApp / SMS — placeholder, mark as sent for demo
    for (const r of campaign.recipients) {
      await prisma.campaignRecipient.update({
        where: { id: r.id },
        data: {
          status: "sent",
          sentAt: new Date(),
          errorMessage: `${campaign.channel} integration not yet active — stub delivery`,
        },
      });
      sent++;
    }
  }

  const finalStatus = failed === campaign.recipients.length ? "failed" : "sent";

  return prisma.campaign.update({
    where: { id },
    data: {
      status: finalStatus,
      sentAt: new Date(),
      sentCount: sent,
      failedCount: failed,
    },
    include: {
      createdBy: { select: { id: true, fullName: true, email: true } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────
export async function getCampaignStats(companyId: string) {
  const [total, draft, sent, sending, scheduled, totalSent, totalOpened] =
    await Promise.all([
      prisma.campaign.count({ where: { companyId } }),
      prisma.campaign.count({ where: { companyId, status: "draft" } }),
      prisma.campaign.count({ where: { companyId, status: "sent" } }),
      prisma.campaign.count({ where: { companyId, status: "sending" } }),
      prisma.campaign.count({ where: { companyId, status: "scheduled" } }),
      prisma.campaign.aggregate({
        where: { companyId },
        _sum: { sentCount: true },
      }),
      prisma.campaign.aggregate({
        where: { companyId },
        _sum: { openedCount: true },
      }),
    ]);

  const totalSentCount = totalSent._sum.sentCount ?? 0;
  const totalOpenedCount = totalOpened._sum.openedCount ?? 0;
  const openRate =
    totalSentCount > 0 ? (totalOpenedCount / totalSentCount) * 100 : 0;

  return {
    total,
    byStatus: { draft, sent, sending, scheduled },
    totalMessagesSent: totalSentCount,
    totalOpens: totalOpenedCount,
    openRatePercent: Math.round(openRate * 10) / 10,
  };
}
