// ============================================================================
// TEMPLATES SEED
// ----------------------------------------------------------------------------
// On backend boot we upsert the curated template catalog so every deploy
// ships the latest versions. Idempotent via slug unique — editing a seed
// here updates existing rows on the next restart.
// ============================================================================

import { prisma } from "../config/database";

interface SeedTemplate {
  slug: string;
  industry: string;
  region: string;
  locale: string;
  name: string;
  nameAr: string;
  nameTr: string;
  tagline: string;
  taglineAr: string;
  taglineTr: string;
  description: string;
  descriptionAr: string;
  descriptionTr: string;
  icon: string;
  color: string;
  isFeatured: boolean;
  sortOrder: number;
  setupMinutes: number;
  bundle: unknown;
}

const TEMPLATES: SeedTemplate[] = [
  // ────────────────────────────────────────────────────────────────
  {
    slug: "apparel-ksa",
    industry: "retail",
    region: "KSA",
    locale: "ar",
    name: "Apparel · Saudi Arabia",
    nameAr: "الملابس · السعودية",
    nameTr: "Giyim · Suudi Arabistan",
    tagline: "Online fashion store with WhatsApp COD flow",
    taglineAr: "متجر أزياء أونلاين مع تدفق دفع عند الاستلام عبر واتساب",
    taglineTr: "WhatsApp üzerinden kapıda ödemeli online moda mağazası",
    description:
      "Pre-built for Saudi fashion boutiques selling via Instagram + WhatsApp. Includes COD flow, sizing fields, Arabic email templates.",
    descriptionAr:
      "مُجهز مسبقًا لبوتيكات الأزياء السعودية اللي تبيع عبر إنستغرام + واتساب. يتضمن تدفق الدفع عند الاستلام، حقول المقاسات، وقوالب بريد بالعربي.",
    descriptionTr:
      "Instagram + WhatsApp üzerinden satış yapan Suudi moda butikleri için hazır. Kapıda ödeme akışı, beden alanları ve Arapça e-posta şablonları içerir.",
    icon: "👗",
    color: "#EC4899",
    isFeatured: true,
    sortOrder: 1,
    setupMinutes: 20,
    bundle: {
      pipelineStages: ["lead", "qualified", "ordered", "shipped", "delivered", "returned"],
      tags: ["abaya", "dress", "accessories", "vip", "returning", "first-order"],
      customerStatuses: ["browsing", "ordering", "returning", "vip", "lost"],
      dealSources: ["instagram", "tiktok", "whatsapp", "referral", "walk-in"],
      customFields: [
        { entityType: "customer", name: "Preferred size", slug: "preferred_size", type: "select", options: ["XS", "S", "M", "L", "XL", "XXL"] },
        { entityType: "customer", name: "Shipping city", slug: "shipping_city", type: "text" },
        { entityType: "deal", name: "Payment method", slug: "payment_method", type: "select", options: ["COD", "Mada", "Apple Pay", "Bank transfer"] },
      ],
      emailTemplates: [
        {
          subject: "Order confirmed — thank you!",
          body: "<p>شكراً لك على طلبك. سيتم التواصل معك خلال 24 ساعة لتأكيد الشحنة.</p>",
          purpose: "order_confirmation",
        },
      ],
      seedCustomers: [
        { fullName: "Fatimah Al-Zahrani", phone: "+966 50 111 2233", companyName: null, status: "customer", source: "instagram" },
        { fullName: "Reem Al-Sabah", phone: "+966 54 555 7788", companyName: null, status: "new", source: "whatsapp" },
        { fullName: "Noura Al-Qahtani", phone: "+966 55 222 9900", companyName: null, status: "customer", source: "tiktok" },
      ],
      seedDeals: [
        { title: "Evening abaya — size M", value: 650, currency: "SAR", stage: "delivered", customerIdx: 0 },
        { title: "Summer dress bundle", value: 1200, currency: "SAR", stage: "ordered", customerIdx: 1 },
      ],
    },
  },
  // ────────────────────────────────────────────────────────────────
  {
    slug: "restaurant-istanbul",
    industry: "restaurants",
    region: "TR",
    locale: "tr",
    name: "Restaurant · Istanbul",
    nameAr: "مطعم · إسطنبول",
    nameTr: "Restoran · İstanbul",
    tagline: "Single-location restaurant with reservation + delivery flow",
    taglineAr: "مطعم بموقع واحد مع تدفق حجوزات + توصيل",
    taglineTr: "Rezervasyon ve teslimat akışlı tek lokasyonlu restoran",
    description:
      "For local restaurants in Turkey — tracks reservations, catering orders, loyalty program members. Turkish lira pricing built in.",
    descriptionAr:
      "للمطاعم المحلية في تركيا — بتتبع الحجوزات، طلبات التموين، أعضاء برنامج الولاء. بسعر الليرة التركية مدمج.",
    descriptionTr:
      "Türkiye'deki yerel restoranlar için — rezervasyonları, catering siparişlerini, sadakat programı üyelerini takip eder. TL fiyatlandırması dahil.",
    icon: "🍽️",
    color: "#F59E0B",
    isFeatured: true,
    sortOrder: 2,
    setupMinutes: 15,
    bundle: {
      pipelineStages: ["inquiry", "reservation", "seated", "served", "followup"],
      tags: ["vip", "regular", "corporate", "birthday", "vegetarian", "gluten-free"],
      customerStatuses: ["first-visit", "regular", "vip", "dormant"],
      dealSources: ["walk-in", "phone", "instagram", "tripadvisor", "google-maps", "referral"],
      customFields: [
        { entityType: "customer", name: "Dietary restrictions", slug: "dietary_restrictions", type: "text" },
        { entityType: "deal", name: "Party size", slug: "party_size", type: "number" },
        { entityType: "deal", name: "Reservation time", slug: "reservation_time", type: "date" },
      ],
      emailTemplates: [
        {
          subject: "Rezervasyonunuz onaylandı",
          body: "<p>Sayın misafirimiz, rezervasyonunuz onaylanmıştır. Bizi tercih ettiğiniz için teşekkür ederiz.</p>",
          purpose: "reservation_confirmation",
        },
      ],
      seedCustomers: [
        { fullName: "Mehmet Yılmaz", phone: "+90 532 111 22 33", companyName: null, status: "customer", source: "instagram" },
        { fullName: "Ayşe Demir", phone: "+90 535 555 44 55", companyName: "Demir Holding", status: "new", source: "phone" },
      ],
      seedDeals: [
        { title: "Anniversary dinner — 4 guests", value: 2800, currency: "TRY", stage: "served", customerIdx: 0 },
        { title: "Corporate lunch — 12 guests", value: 8400, currency: "TRY", stage: "reservation", customerIdx: 1 },
      ],
    },
  },
  // ────────────────────────────────────────────────────────────────
  {
    slug: "saas-b2b",
    industry: "saas",
    region: "GLOBAL",
    locale: "en",
    name: "SaaS · B2B",
    nameAr: "برمجيات كخدمة · B2B",
    nameTr: "SaaS · B2B",
    tagline: "Outbound sales flow for B2B SaaS companies",
    taglineAr: "تدفق مبيعات خارجي لشركات SaaS B2B",
    taglineTr: "B2B SaaS şirketleri için outbound satış akışı",
    description:
      "Classic B2B SaaS pipeline: prospect → qualified → demo → trial → closed-won. Includes demo scheduling email, discovery call template.",
    descriptionAr:
      "خط أنابيب كلاسيكي لـ B2B SaaS: عميل محتمل → مؤهل → عرض → تجربة → إغلاق. يشمل قوالب بريد جدولة العرض ومكالمة الاكتشاف.",
    descriptionTr:
      "Klasik B2B SaaS hunisi: aday → nitelikli → demo → deneme → kapanış. Demo planlama e-postası ve keşif araması şablonu dahil.",
    icon: "💻",
    color: "#0891B2",
    isFeatured: true,
    sortOrder: 3,
    setupMinutes: 25,
    bundle: {
      pipelineStages: ["prospect", "qualified", "demo", "trial", "proposal", "negotiation", "won", "lost"],
      tags: ["enterprise", "smb", "startup", "champion", "decision-maker", "blocker"],
      customerStatuses: ["cold", "warm", "qualified", "customer", "churned"],
      dealSources: ["cold-outbound", "inbound", "linkedin", "referral", "webinar", "content"],
      customFields: [
        { entityType: "customer", name: "Company size", slug: "company_size", type: "select", options: ["1-10", "11-50", "51-200", "201-1000", "1000+"] },
        { entityType: "customer", name: "Tech stack", slug: "tech_stack", type: "text" },
        { entityType: "deal", name: "MRR", slug: "mrr", type: "number" },
        { entityType: "deal", name: "Contract length (months)", slug: "contract_length", type: "number" },
      ],
      emailTemplates: [
        {
          subject: "Quick demo of {{productName}}?",
          body: "<p>Hi {{firstName}},</p><p>Saw {{companyName}} is growing fast — 15-min demo of {{productName}} next week?</p>",
          purpose: "demo_request",
        },
        {
          subject: "Following up on our conversation",
          body: "<p>Hi {{firstName}},</p><p>Wanted to send over the trial link and next steps we discussed.</p>",
          purpose: "followup",
        },
      ],
      seedCustomers: [
        { fullName: "John Anderson", email: "j.anderson@acme.co", companyName: "Acme Corp", status: "qualified", source: "linkedin" },
        { fullName: "Sarah Chen", email: "sarah@techflow.io", companyName: "TechFlow", status: "new", source: "inbound" },
        { fullName: "David Kim", email: "david.kim@brightstart.com", companyName: "BrightStart", status: "qualified", source: "referral" },
      ],
      seedDeals: [
        { title: "Acme — Enterprise tier (50 seats)", value: 24000, currency: "USD", stage: "proposal", customerIdx: 0 },
        { title: "TechFlow — Starter (5 seats)", value: 3600, currency: "USD", stage: "demo", customerIdx: 1 },
        { title: "BrightStart — Business tier", value: 12000, currency: "USD", stage: "trial", customerIdx: 2 },
      ],
    },
  },
  // ────────────────────────────────────────────────────────────────
  {
    slug: "services-agency",
    industry: "services",
    region: "GLOBAL",
    locale: "en",
    name: "Services · Agency",
    nameAr: "خدمات · وكالة",
    nameTr: "Hizmetler · Ajans",
    tagline: "Project-based creative/consulting agency",
    taglineAr: "وكالة إبداعية/استشارية قائمة على المشاريع",
    taglineTr: "Proje bazlı yaratıcı/danışmanlık ajansı",
    description:
      "Fit for design studios, consultancies, dev shops. Tracks project-stage deals with retainer + scope fields.",
    descriptionAr:
      "مناسب لاستوديوهات التصميم والاستشارات وشركات التطوير. بيتبع صفقات بمراحل المشاريع مع حقول الاتفاق والنطاق.",
    descriptionTr:
      "Tasarım stüdyoları, danışmanlıklar, yazılım evleri için uygundur. Proje aşamalı anlaşmaları retainer + kapsam alanlarıyla takip eder.",
    icon: "🎨",
    color: "#8B5CF6",
    isFeatured: false,
    sortOrder: 4,
    setupMinutes: 20,
    bundle: {
      pipelineStages: ["brief", "proposal", "signed", "in-progress", "review", "delivered"],
      tags: ["retainer", "one-off", "rush", "pro-bono", "referral-source"],
      customerStatuses: ["prospect", "active-client", "past-client", "referral-only"],
      dealSources: ["referral", "portfolio", "cold-outbound", "linkedin", "network"],
      customFields: [
        { entityType: "deal", name: "Project type", slug: "project_type", type: "select", options: ["Branding", "Website", "Strategy", "Content", "Ongoing"] },
        { entityType: "deal", name: "Scope (hours)", slug: "scope_hours", type: "number" },
        { entityType: "deal", name: "Retainer monthly?", slug: "is_retainer", type: "select", options: ["Yes", "No"] },
      ],
      emailTemplates: [
        {
          subject: "Project brief — {{dealTitle}}",
          body: "<p>Hi {{firstName}},</p><p>Thanks for the conversation. Attached is our scope + timeline for your review.</p>",
          purpose: "proposal",
        },
      ],
      seedCustomers: [
        { fullName: "Emma Wallace", email: "emma@studio-w.com", companyName: "Studio W", status: "customer", source: "referral" },
        { fullName: "Omar Hassan", email: "omar@hassan-co.com", companyName: "Hassan & Co", status: "new", source: "linkedin" },
      ],
      seedDeals: [
        { title: "Studio W — website redesign", value: 18000, currency: "USD", stage: "signed", customerIdx: 0 },
        { title: "Hassan — brand refresh", value: 9500, currency: "USD", stage: "proposal", customerIdx: 1 },
      ],
    },
  },
];

export async function seedTemplates() {
  for (const t of TEMPLATES) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO templates
         (id, slug, industry, region, locale,
          name, "nameAr", "nameTr",
          tagline, "taglineAr", "taglineTr",
          description, "descriptionAr", "descriptionTr",
          icon, color, "isFeatured", "isActive", "sortOrder",
          bundle, "setupMinutes",
          "createdAt", "updatedAt")
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7,
          $8, $9, $10,
          $11, $12, $13,
          $14, $15, $16, true, $17,
          $18::jsonb, $19,
          NOW(), NOW())
       ON CONFLICT (slug) DO UPDATE SET
         industry = EXCLUDED.industry,
         region = EXCLUDED.region,
         locale = EXCLUDED.locale,
         name = EXCLUDED.name,
         "nameAr" = EXCLUDED."nameAr",
         "nameTr" = EXCLUDED."nameTr",
         tagline = EXCLUDED.tagline,
         "taglineAr" = EXCLUDED."taglineAr",
         "taglineTr" = EXCLUDED."taglineTr",
         description = EXCLUDED.description,
         "descriptionAr" = EXCLUDED."descriptionAr",
         "descriptionTr" = EXCLUDED."descriptionTr",
         icon = EXCLUDED.icon,
         color = EXCLUDED.color,
         "isFeatured" = EXCLUDED."isFeatured",
         "sortOrder" = EXCLUDED."sortOrder",
         bundle = EXCLUDED.bundle,
         "setupMinutes" = EXCLUDED."setupMinutes",
         "updatedAt" = NOW()`,
      t.slug,
      t.industry,
      t.region,
      t.locale,
      t.name,
      t.nameAr,
      t.nameTr,
      t.tagline,
      t.taglineAr,
      t.taglineTr,
      t.description,
      t.descriptionAr,
      t.descriptionTr,
      t.icon,
      t.color,
      t.isFeatured,
      t.sortOrder,
      JSON.stringify(t.bundle),
      t.setupMinutes
    );
  }
  console.log(`[templates] Seeded ${TEMPLATES.length} templates`);
}
