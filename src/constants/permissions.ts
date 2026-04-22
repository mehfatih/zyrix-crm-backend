// ============================================================================
// RBAC — Permission catalog + default built-in role mappings (P1)
// ----------------------------------------------------------------------------
// This file is the single source of truth for permission keys. The admin
// `/settings/roles` UI reads PERMISSION_CATALOG to render the picker, and
// requirePermission() middleware checks against these keys.
//
// Built-in roles owner / admin / manager / member still exist as string
// values on User.role for backwards compatibility. Their default permission
// sets live in DEFAULT_ROLE_PERMISSIONS below and are used as the fallback
// whenever User.customRoleId is null.
// ============================================================================

export const PERMISSIONS = [
  "customers:read",
  "customers:write",
  "customers:delete",
  "deals:read",
  "deals:write",
  "deals:delete",
  "quotes:read",
  "quotes:write",
  "quotes:issue",
  "contracts:read",
  "contracts:write",
  "contracts:sign",
  "invoices:read",
  "invoices:issue",
  "invoices:void",
  "reports:view_own",
  "reports:view_all",
  "settings:billing",
  "settings:users",
  "settings:roles",
  "settings:branding",
  "settings:integrations",
  "admin:impersonate",
  "admin:audit",
  "admin:compliance",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// ──────────────────────────────────────────────────────────────────────
// Rich catalog for the admin UI — grouped by module with trilingual
// labels. Frontend renders a collapsible picker per module.
// ──────────────────────────────────────────────────────────────────────

export interface PermissionEntry {
  key: Permission;
  module:
    | "customers"
    | "deals"
    | "quotes"
    | "contracts"
    | "invoices"
    | "reports"
    | "settings"
    | "admin";
  action: string;
  label: { en: string; ar: string; tr: string };
  description: { en: string; ar: string; tr: string };
}

export const PERMISSION_CATALOG: PermissionEntry[] = [
  {
    key: "customers:read",
    module: "customers",
    action: "read",
    label: { en: "View customers", ar: "عرض العملاء", tr: "Müşterileri görüntüle" },
    description: {
      en: "See the customer list and customer detail pages",
      ar: "عرض قائمة العملاء وصفحات التفاصيل",
      tr: "Müşteri listesini ve detay sayfalarını görüntüle",
    },
  },
  {
    key: "customers:write",
    module: "customers",
    action: "write",
    label: { en: "Edit customers", ar: "تعديل العملاء", tr: "Müşterileri düzenle" },
    description: {
      en: "Create and update customer records",
      ar: "إنشاء وتحديث سجلات العملاء",
      tr: "Müşteri kayıtları oluştur ve güncelle",
    },
  },
  {
    key: "customers:delete",
    module: "customers",
    action: "delete",
    label: { en: "Delete customers", ar: "حذف العملاء", tr: "Müşterileri sil" },
    description: {
      en: "Soft-delete customer records",
      ar: "حذف سجلات العملاء",
      tr: "Müşteri kayıtlarını sil",
    },
  },
  {
    key: "deals:read",
    module: "deals",
    action: "read",
    label: { en: "View deals", ar: "عرض الصفقات", tr: "Anlaşmaları görüntüle" },
    description: {
      en: "See the pipeline and deal detail pages",
      ar: "عرض خط الأنابيب وصفحات الصفقات",
      tr: "Pipeline ve anlaşma detay sayfalarını görüntüle",
    },
  },
  {
    key: "deals:write",
    module: "deals",
    action: "write",
    label: { en: "Edit deals", ar: "تعديل الصفقات", tr: "Anlaşmaları düzenle" },
    description: {
      en: "Create and update deals, move pipeline stages",
      ar: "إنشاء وتحديث الصفقات ونقل المراحل",
      tr: "Anlaşma oluştur, güncelle ve aşamaları taşı",
    },
  },
  {
    key: "deals:delete",
    module: "deals",
    action: "delete",
    label: { en: "Delete deals", ar: "حذف الصفقات", tr: "Anlaşmaları sil" },
    description: {
      en: "Remove deals from the pipeline",
      ar: "إزالة الصفقات من خط الأنابيب",
      tr: "Anlaşmaları pipeline'dan kaldır",
    },
  },
  {
    key: "quotes:read",
    module: "quotes",
    action: "read",
    label: { en: "View quotes", ar: "عرض العروض", tr: "Teklifleri görüntüle" },
    description: {
      en: "See quote drafts and history",
      ar: "عرض مسودات العروض والسجل",
      tr: "Teklif taslaklarını ve geçmişi görüntüle",
    },
  },
  {
    key: "quotes:write",
    module: "quotes",
    action: "write",
    label: { en: "Edit quotes", ar: "تعديل العروض", tr: "Teklifleri düzenle" },
    description: {
      en: "Create and update quote drafts",
      ar: "إنشاء وتحديث مسودات العروض",
      tr: "Teklif taslakları oluştur ve güncelle",
    },
  },
  {
    key: "quotes:issue",
    module: "quotes",
    action: "issue",
    label: { en: "Issue quotes", ar: "إصدار العروض", tr: "Teklif yayınla" },
    description: {
      en: "Send / finalize quotes to customers",
      ar: "إرسال العروض النهائية للعملاء",
      tr: "Müşterilere kesin teklif gönder",
    },
  },
  {
    key: "contracts:read",
    module: "contracts",
    action: "read",
    label: { en: "View contracts", ar: "عرض العقود", tr: "Sözleşmeleri görüntüle" },
    description: {
      en: "See contracts and their status",
      ar: "عرض العقود وحالاتها",
      tr: "Sözleşmeleri ve durumlarını görüntüle",
    },
  },
  {
    key: "contracts:write",
    module: "contracts",
    action: "write",
    label: { en: "Edit contracts", ar: "تعديل العقود", tr: "Sözleşmeleri düzenle" },
    description: {
      en: "Create and edit contract drafts",
      ar: "إنشاء وتعديل مسودات العقود",
      tr: "Sözleşme taslakları oluştur ve düzenle",
    },
  },
  {
    key: "contracts:sign",
    module: "contracts",
    action: "sign",
    label: { en: "Sign contracts", ar: "توقيع العقود", tr: "Sözleşmeleri imzala" },
    description: {
      en: "Execute contracts and request signatures",
      ar: "تنفيذ العقود وطلب التوقيعات",
      tr: "Sözleşmeleri imzala ve imza talep et",
    },
  },
  {
    key: "invoices:read",
    module: "invoices",
    action: "read",
    label: { en: "View invoices", ar: "عرض الفواتير", tr: "Faturaları görüntüle" },
    description: {
      en: "See the invoice list and PDFs",
      ar: "عرض قائمة الفواتير وملفات PDF",
      tr: "Fatura listesini ve PDF'leri görüntüle",
    },
  },
  {
    key: "invoices:issue",
    module: "invoices",
    action: "issue",
    label: { en: "Issue invoices", ar: "إصدار الفواتير", tr: "Fatura yayınla" },
    description: {
      en: "Create and finalize tax invoices (ZATCA / e-Fatura)",
      ar: "إنشاء وإصدار فواتير ضريبية (زاتكا / e-Fatura)",
      tr: "Vergi faturası oluştur ve kesinleştir (ZATCA / e-Fatura)",
    },
  },
  {
    key: "invoices:void",
    module: "invoices",
    action: "void",
    label: { en: "Void invoices", ar: "إلغاء الفواتير", tr: "Faturayı iptal et" },
    description: {
      en: "Void / issue credit notes on finalized invoices",
      ar: "إلغاء / إصدار إشعارات دائنة على الفواتير",
      tr: "Faturayı iptal et / alacak dekontu düzenle",
    },
  },
  {
    key: "reports:view_own",
    module: "reports",
    action: "view_own",
    label: {
      en: "View own reports",
      ar: "عرض تقاريري",
      tr: "Kendi raporlarımı görüntüle",
    },
    description: {
      en: "See reports scoped to this user's owned records",
      ar: "عرض التقارير المقتصرة على سجلات هذا المستخدم",
      tr: "Yalnızca bu kullanıcıya ait kayıtların raporlarını gör",
    },
  },
  {
    key: "reports:view_all",
    module: "reports",
    action: "view_all",
    label: {
      en: "View all reports",
      ar: "عرض جميع التقارير",
      tr: "Tüm raporları görüntüle",
    },
    description: {
      en: "See company-wide reports across all users",
      ar: "عرض تقارير الشركة عبر جميع المستخدمين",
      tr: "Tüm kullanıcıları kapsayan şirket raporlarını gör",
    },
  },
  {
    key: "settings:billing",
    module: "settings",
    action: "billing",
    label: {
      en: "Billing settings",
      ar: "إعدادات الفوترة",
      tr: "Fatura ayarları",
    },
    description: {
      en: "Manage plan, payment method, invoices received",
      ar: "إدارة الخطة وطريقة الدفع والفواتير المستلمة",
      tr: "Plan, ödeme yöntemi ve alınan faturaları yönet",
    },
  },
  {
    key: "settings:users",
    module: "settings",
    action: "users",
    label: {
      en: "User management",
      ar: "إدارة المستخدمين",
      tr: "Kullanıcı yönetimi",
    },
    description: {
      en: "Invite, disable, and assign roles to team members",
      ar: "دعوة وتعطيل وتعيين أدوار لأعضاء الفريق",
      tr: "Ekip üyelerini davet et, devre dışı bırak, rol ata",
    },
  },
  {
    key: "settings:roles",
    module: "settings",
    action: "roles",
    label: {
      en: "Role management",
      ar: "إدارة الأدوار",
      tr: "Rol yönetimi",
    },
    description: {
      en: "Create, edit, and delete custom roles",
      ar: "إنشاء وتعديل وحذف الأدوار المخصصة",
      tr: "Özel roller oluştur, düzenle ve sil",
    },
  },
  {
    key: "settings:branding",
    module: "settings",
    action: "branding",
    label: {
      en: "Branding settings",
      ar: "إعدادات العلامة التجارية",
      tr: "Marka ayarları",
    },
    description: {
      en: "Manage brands, logos, and company profile",
      ar: "إدارة العلامات التجارية والشعارات وملف الشركة",
      tr: "Markaları, logoları ve şirket profilini yönet",
    },
  },
  {
    key: "settings:integrations",
    module: "settings",
    action: "integrations",
    label: {
      en: "Integration settings",
      ar: "إعدادات التكاملات",
      tr: "Entegrasyon ayarları",
    },
    description: {
      en: "Connect email, WhatsApp, Stripe, Google, webhooks",
      ar: "ربط البريد وواتساب وStripe وGoogle وwebhooks",
      tr: "E-posta, WhatsApp, Stripe, Google ve webhook bağla",
    },
  },
  {
    key: "admin:impersonate",
    module: "admin",
    action: "impersonate",
    label: {
      en: "Impersonate users",
      ar: "انتحال هوية المستخدمين",
      tr: "Kullanıcı kimliğine bürün",
    },
    description: {
      en: "Log in as another user in this company for support",
      ar: "الدخول كمستخدم آخر في هذه الشركة للدعم",
      tr: "Destek amacıyla bu şirketteki başka bir kullanıcı olarak oturum aç",
    },
  },
  {
    key: "admin:audit",
    module: "admin",
    action: "audit",
    label: {
      en: "View audit logs",
      ar: "عرض سجلات التدقيق",
      tr: "Denetim kayıtlarını görüntüle",
    },
    description: {
      en: "See the full audit trail of actions across this company",
      ar: "عرض السجل الكامل للإجراءات عبر الشركة",
      tr: "Şirket çapındaki eylemlerin tam denetim izini görüntüle",
    },
  },
  {
    key: "admin:compliance",
    module: "admin",
    action: "compliance",
    label: {
      en: "Compliance settings",
      ar: "إعدادات الامتثال",
      tr: "Uyumluluk ayarları",
    },
    description: {
      en: "Manage retention policies, legal holds, GDPR/CCPA tools",
      ar: "إدارة سياسات الاحتفاظ والحجز القانوني وأدوات GDPR/CCPA",
      tr: "Saklama politikaları, yasal saklama ve GDPR/CCPA araçlarını yönet",
    },
  },
];

// ──────────────────────────────────────────────────────────────────────
// Built-in role fallback permissions
// ──────────────────────────────────────────────────────────────────────
// Applied whenever User.customRoleId is null. If a merchant wants a
// permission set that doesn't match one of these four, they create a
// custom Role and assign it to the user via User.customRoleId.
// ──────────────────────────────────────────────────────────────────────

export type BuiltInRole = "owner" | "admin" | "manager" | "member";

const ALL_PERMISSIONS: Permission[] = [...PERMISSIONS];

export const DEFAULT_ROLE_PERMISSIONS: Record<BuiltInRole, Permission[]> = {
  // Full control — everything including billing, user management, roles.
  owner: ALL_PERMISSIONS,

  // Everything except owner-only settings (billing, users, roles).
  admin: ALL_PERMISSIONS.filter(
    (p) => p !== "settings:billing" && p !== "settings:users" && p !== "settings:roles"
  ),

  // Read + write on business objects, see all reports, no settings, no admin.
  manager: [
    "customers:read",
    "customers:write",
    "customers:delete",
    "deals:read",
    "deals:write",
    "deals:delete",
    "quotes:read",
    "quotes:write",
    "quotes:issue",
    "contracts:read",
    "contracts:write",
    "contracts:sign",
    "invoices:read",
    "invoices:issue",
    "reports:view_own",
    "reports:view_all",
  ],

  // Day-to-day ops: read + write customers/deals, read-only on paper docs,
  // own reports only.
  member: [
    "customers:read",
    "customers:write",
    "deals:read",
    "deals:write",
    "quotes:read",
    "contracts:read",
    "invoices:read",
    "reports:view_own",
  ],
};

export function getBuiltInRolePermissions(role: string): Permission[] {
  if (role === "owner" || role === "admin" || role === "manager" || role === "member") {
    return DEFAULT_ROLE_PERMISSIONS[role];
  }
  // super_admin, unknown, or missing — grant nothing. Super-admin flow
  // bypasses permission checks elsewhere (platform-owner scope).
  return [];
}

export function isValidPermission(key: string): key is Permission {
  return (PERMISSIONS as readonly string[]).includes(key);
}
