// ============================================================================
// WORKFLOW SPEC CATALOG
// ----------------------------------------------------------------------------
// Canonical list of trigger + action types. Adding a new trigger/action is:
//   1. Register entry here with name/description/configFields
//   2. Add dispatch case in dispatchEvent()  (triggers — next session)
//   3. Add run case in runAction()          (actions — next session)
//   4. Add entry to frontend registry       (next session's frontend work)
// ============================================================================

export interface SpecField {
  key: string;
  label: { en: string; ar: string; tr: string };
  type: "text" | "number" | "select" | "textarea" | "boolean" | "cron";
  required?: boolean;
  options?: string[];   // for type=select
  placeholder?: string;
  helpText?: { en: string; ar: string; tr: string };
}

export interface TriggerSpec {
  type: string;
  label: { en: string; ar: string; tr: string };
  description: { en: string; ar: string; tr: string };
  category: "crm" | "schedule" | "external";
  configFields: SpecField[];
  // What fields the trigger payload will expose to action templating.
  // Documentation for users building workflows — not enforced at runtime.
  payloadFields: string[];
}

export interface ActionSpec {
  type: string;
  label: { en: string; ar: string; tr: string };
  description: { en: string; ar: string; tr: string };
  category: "messaging" | "crm" | "external";
  configFields: SpecField[];
}

// ──────────────────────────────────────────────────────────────────────
// TRIGGERS
// ──────────────────────────────────────────────────────────────────────

export const TRIGGERS: TriggerSpec[] = [
  {
    type: "customer.created",
    label: {
      en: "New customer added",
      ar: "إضافة عميل جديد",
      tr: "Yeni müşteri eklendi",
    },
    description: {
      en: "Fires whenever a customer record is created",
      ar: "يعمل كل ما تم إنشاء سجل عميل",
      tr: "Bir müşteri kaydı oluşturulduğunda tetiklenir",
    },
    category: "crm",
    configFields: [],
    payloadFields: [
      "customer.id",
      "customer.fullName",
      "customer.email",
      "customer.phone",
      "customer.status",
      "customer.source",
    ],
  },
  {
    type: "customer.status_changed",
    label: {
      en: "Customer status changed",
      ar: "تغيّر حالة العميل",
      tr: "Müşteri durumu değişti",
    },
    description: {
      en: "Fires when a customer moves to a specific status",
      ar: "يعمل لما عميل يتحرك لحالة معينة",
      tr: "Bir müşteri belirli bir duruma taşındığında tetiklenir",
    },
    category: "crm",
    configFields: [
      {
        key: "toStatus",
        label: { en: "New status", ar: "الحالة الجديدة", tr: "Yeni durum" },
        type: "select",
        required: true,
        options: ["new", "qualified", "customer", "lost"],
      },
    ],
    payloadFields: [
      "customer.id",
      "customer.fullName",
      "customer.status",
      "previousStatus",
    ],
  },
  {
    type: "deal.created",
    label: { en: "New deal created", ar: "إنشاء صفقة جديدة", tr: "Yeni anlaşma oluşturuldu" },
    description: {
      en: "Fires whenever a deal record is created",
      ar: "يعمل كل ما تم إنشاء سجل صفقة",
      tr: "Bir anlaşma kaydı oluşturulduğunda tetiklenir",
    },
    category: "crm",
    configFields: [],
    payloadFields: [
      "deal.id",
      "deal.title",
      "deal.value",
      "deal.currency",
      "deal.stage",
      "customer.id",
      "customer.fullName",
      "customer.email",
    ],
  },
  {
    type: "deal.stage_changed",
    label: {
      en: "Deal moved to stage",
      ar: "تم نقل الصفقة لمرحلة",
      tr: "Anlaşma aşamaya taşındı",
    },
    description: {
      en: "Fires when a deal moves into a specific pipeline stage",
      ar: "يعمل لما صفقة تنتقل لمرحلة معينة في المسار",
      tr: "Anlaşma belirli bir pipeline aşamasına taşındığında tetiklenir",
    },
    category: "crm",
    configFields: [
      {
        key: "toStage",
        label: { en: "Target stage", ar: "المرحلة المستهدفة", tr: "Hedef aşama" },
        type: "text",
        required: true,
        placeholder: "proposal",
      },
    ],
    payloadFields: [
      "deal.id",
      "deal.title",
      "deal.value",
      "deal.stage",
      "previousStage",
      "customer.id",
      "customer.fullName",
    ],
  },
  {
    type: "deal.won",
    label: { en: "Deal won", ar: "فوز بصفقة", tr: "Anlaşma kazanıldı" },
    description: {
      en: "Fires whenever a deal is marked as won",
      ar: "يعمل كل ما تم تحديد صفقة على أنها مكسوبة",
      tr: "Bir anlaşma kazanıldı olarak işaretlendiğinde tetiklenir",
    },
    category: "crm",
    configFields: [],
    payloadFields: [
      "deal.id",
      "deal.title",
      "deal.value",
      "deal.currency",
      "customer.id",
      "customer.fullName",
    ],
  },
  {
    type: "deal.lost",
    label: { en: "Deal lost", ar: "فقدان صفقة", tr: "Anlaşma kaybedildi" },
    description: {
      en: "Fires whenever a deal is marked as lost",
      ar: "يعمل كل ما تم تحديد صفقة على أنها مفقودة",
      tr: "Bir anlaşma kaybedildi olarak işaretlendiğinde tetiklenir",
    },
    category: "crm",
    configFields: [],
    payloadFields: [
      "deal.id",
      "deal.title",
      "deal.value",
      "customer.id",
      "customer.fullName",
    ],
  },
  {
    type: "activity.completed",
    label: { en: "Activity completed", ar: "نشاط مكتمل", tr: "Etkinlik tamamlandı" },
    description: {
      en: "Fires when a task/activity is marked completed",
      ar: "يعمل لما يتم تحديد مهمة على أنها مكتملة",
      tr: "Bir görev/etkinlik tamamlandı olarak işaretlendiğinde tetiklenir",
    },
    category: "crm",
    configFields: [
      {
        key: "activityType",
        label: { en: "Activity type (optional)", ar: "نوع النشاط (اختياري)", tr: "Etkinlik türü (isteğe bağlı)" },
        type: "select",
        options: ["", "call", "email", "meeting", "task", "note"],
      },
    ],
    payloadFields: [
      "activity.id",
      "activity.type",
      "activity.title",
      "customer.id",
      "customer.fullName",
    ],
  },
  {
    type: "schedule.daily",
    label: { en: "Daily schedule", ar: "جدولة يومية", tr: "Günlük zamanlama" },
    description: {
      en: "Runs every day at a specified hour",
      ar: "يشتغل كل يوم في ساعة محددة",
      tr: "Her gün belirlenen saatte çalışır",
    },
    category: "schedule",
    configFields: [
      {
        key: "hour",
        label: { en: "Hour (0-23)", ar: "الساعة (0-23)", tr: "Saat (0-23)" },
        type: "number",
        required: true,
        helpText: {
          en: "Company timezone is used",
          ar: "يُستخدم توقيت الشركة",
          tr: "Şirket saat dilimi kullanılır",
        },
      },
    ],
    payloadFields: ["timestamp"],
  },
  {
    type: "schedule.weekly",
    label: { en: "Weekly schedule", ar: "جدولة أسبوعية", tr: "Haftalık zamanlama" },
    description: {
      en: "Runs once a week on a specified day + hour",
      ar: "يشتغل مرة أسبوعياً في يوم وساعة محددين",
      tr: "Haftada bir kez belirlenen gün ve saatte çalışır",
    },
    category: "schedule",
    configFields: [
      {
        key: "dayOfWeek",
        label: { en: "Day of week", ar: "يوم الأسبوع", tr: "Haftanın günü" },
        type: "select",
        required: true,
        options: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
      },
      {
        key: "hour",
        label: { en: "Hour (0-23)", ar: "الساعة (0-23)", tr: "Saat (0-23)" },
        type: "number",
        required: true,
      },
    ],
    payloadFields: ["timestamp"],
  },
  {
    type: "webhook.received",
    label: { en: "External webhook", ar: "webhook خارجي", tr: "Harici webhook" },
    description: {
      en: "Fires when an external system POSTs to your workflow URL",
      ar: "يعمل لما نظام خارجي يبعت POST لرابط الـ workflow",
      tr: "Harici bir sistem iş akışı URL'nize POST yaptığında tetiklenir",
    },
    category: "external",
    configFields: [],
    payloadFields: ["body.*", "headers.*"],
  },
];

// ──────────────────────────────────────────────────────────────────────
// ACTIONS
// ──────────────────────────────────────────────────────────────────────

export const ACTIONS: ActionSpec[] = [
  {
    type: "send_whatsapp_message",
    label: { en: "Send WhatsApp message", ar: "إرسال رسالة واتساب", tr: "WhatsApp mesajı gönder" },
    description: {
      en: "Sends a WhatsApp message using your business account",
      ar: "يرسل رسالة واتساب باستخدام حسابك التجاري",
      tr: "İşletme hesabınızı kullanarak WhatsApp mesajı gönderir",
    },
    category: "messaging",
    configFields: [
      {
        key: "toPhone",
        label: { en: "To phone", ar: "إلى هاتف", tr: "Alıcı telefon" },
        type: "text",
        required: true,
        placeholder: "{{customer.phone}}",
        helpText: {
          en: "Use {{customer.phone}} to send to the triggering customer",
          ar: "استخدم {{customer.phone}} للإرسال لعميل الترجير",
          tr: "Tetikleyen müşteriye göndermek için {{customer.phone}} kullanın",
        },
      },
      {
        key: "message",
        label: { en: "Message", ar: "الرسالة", tr: "Mesaj" },
        type: "textarea",
        required: true,
      },
    ],
  },
  {
    type: "send_email",
    label: { en: "Send email", ar: "إرسال بريد", tr: "E-posta gönder" },
    description: {
      en: "Sends an email using an existing email template",
      ar: "يرسل بريد إلكتروني باستخدام قالب موجود",
      tr: "Mevcut bir e-posta şablonunu kullanarak e-posta gönderir",
    },
    category: "messaging",
    configFields: [
      {
        key: "toEmail",
        label: { en: "To email", ar: "إلى بريد", tr: "Alıcı e-posta" },
        type: "text",
        required: true,
        placeholder: "{{customer.email}}",
      },
      {
        key: "subject",
        label: { en: "Subject", ar: "الموضوع", tr: "Konu" },
        type: "text",
        required: true,
      },
      {
        key: "body",
        label: { en: "Body (HTML)", ar: "النص (HTML)", tr: "Gövde (HTML)" },
        type: "textarea",
        required: true,
      },
    ],
  },
  {
    type: "create_task",
    label: { en: "Create task", ar: "إنشاء مهمة", tr: "Görev oluştur" },
    description: {
      en: "Creates a task assigned to someone",
      ar: "ينشئ مهمة معينة لشخص",
      tr: "Birine atanan bir görev oluşturur",
    },
    category: "crm",
    configFields: [
      {
        key: "title",
        label: { en: "Task title", ar: "عنوان المهمة", tr: "Görev başlığı" },
        type: "text",
        required: true,
      },
      {
        key: "assigneeId",
        label: { en: "Assignee user id", ar: "معرّف الشخص المسؤول", tr: "Atanan kullanıcı kimliği" },
        type: "text",
        helpText: {
          en: "Leave blank to assign to the workflow creator",
          ar: "اتركه فارغاً لتعيينه لمنشئ الـ workflow",
          tr: "İş akışı oluşturucusuna atamak için boş bırakın",
        },
      },
      {
        key: "dueDays",
        label: { en: "Due in (days)", ar: "تسليم خلال (أيام)", tr: "Son teslim (gün)" },
        type: "number",
      },
    ],
  },
  {
    type: "update_deal_stage",
    label: { en: "Move deal to stage", ar: "نقل الصفقة لمرحلة", tr: "Anlaşmayı aşamaya taşı" },
    description: {
      en: "Updates the triggering deal's stage",
      ar: "يحدّث مرحلة الصفقة اللي فعّلت الـ workflow",
      tr: "Tetikleyen anlaşmanın aşamasını günceller",
    },
    category: "crm",
    configFields: [
      {
        key: "toStage",
        label: { en: "New stage", ar: "المرحلة الجديدة", tr: "Yeni aşama" },
        type: "text",
        required: true,
      },
    ],
  },
  {
    type: "update_customer_status",
    label: { en: "Update customer status", ar: "تحديث حالة العميل", tr: "Müşteri durumunu güncelle" },
    description: {
      en: "Sets the triggering customer's status",
      ar: "يغيّر حالة العميل اللي فعّل الـ workflow",
      tr: "Tetikleyen müşterinin durumunu ayarlar",
    },
    category: "crm",
    configFields: [
      {
        key: "toStatus",
        label: { en: "New status", ar: "الحالة الجديدة", tr: "Yeni durum" },
        type: "select",
        required: true,
        options: ["new", "qualified", "customer", "lost"],
      },
    ],
  },
  {
    type: "add_tag",
    label: { en: "Add tag to customer", ar: "إضافة وسم للعميل", tr: "Müşteriye etiket ekle" },
    description: {
      en: "Tags the triggering customer with the specified tag",
      ar: "يضيف وسم للعميل اللي فعّل الـ workflow",
      tr: "Tetikleyen müşteriye belirtilen etiketi ekler",
    },
    category: "crm",
    configFields: [
      {
        key: "tagName",
        label: { en: "Tag name", ar: "اسم الوسم", tr: "Etiket adı" },
        type: "text",
        required: true,
      },
    ],
  },
  {
    type: "call_webhook",
    label: { en: "Call external webhook", ar: "استدعاء webhook خارجي", tr: "Harici webhook çağır" },
    description: {
      en: "POSTs the trigger payload to an external URL",
      ar: "يبعت POST بمحتوى الـ trigger لرابط خارجي",
      tr: "Tetikleyici yükünü harici bir URL'ye POST eder",
    },
    category: "external",
    configFields: [
      {
        key: "url",
        label: { en: "URL", ar: "الرابط", tr: "URL" },
        type: "text",
        required: true,
        placeholder: "https://example.com/hook",
      },
      {
        key: "method",
        label: { en: "Method", ar: "الطريقة", tr: "Yöntem" },
        type: "select",
        options: ["POST", "PUT", "PATCH"],
      },
      {
        key: "authHeader",
        label: { en: "Auth header (optional)", ar: "ترويسة المصادقة (اختياري)", tr: "Yetkilendirme başlığı (isteğe bağlı)" },
        type: "text",
        placeholder: "Bearer abc123",
      },
    ],
  },
];

// ──────────────────────────────────────────────────────────────────────
// AI-NATIVE ACTIONS (P10) — all powered by Gemini 2.0 Flash
// ──────────────────────────────────────────────────────────────────────

ACTIONS.push(
  {
    type: "ai_generate_email",
    label: {
      en: "AI · Generate email",
      ar: "AI · توليد بريد",
      tr: "AI · E-posta oluştur",
    },
    description: {
      en: "Draft a subject + body from a short purpose description.",
      ar: "إنشاء عنوان ونص بريد من وصف قصير.",
      tr: "Kısa açıklamadan konu + gövde oluştur.",
    },
    category: "messaging",
    configFields: [
      {
        key: "purpose",
        label: { en: "Purpose", ar: "الغرض", tr: "Amaç" },
        type: "textarea",
        required: true,
        placeholder:
          "Follow up on the pending quote, ask for a decision by Friday",
      },
      {
        key: "tone",
        label: { en: "Tone", ar: "النبرة", tr: "Ton" },
        type: "select",
        options: ["professional", "friendly", "concise", "warm"],
      },
      {
        key: "locale",
        label: { en: "Language", ar: "اللغة", tr: "Dil" },
        type: "select",
        options: ["en", "ar", "tr"],
      },
    ],
  },
  {
    type: "ai_summarize",
    label: {
      en: "AI · Summarize",
      ar: "AI · تلخيص",
      tr: "AI · Özetle",
    },
    description: {
      en: "Reduce a long text to a short summary.",
      ar: "تقليل نص طويل إلى ملخص قصير.",
      tr: "Uzun metni kısa özete indir.",
    },
    category: "messaging",
    configFields: [
      {
        key: "text",
        label: { en: "Text to summarize", ar: "النص", tr: "Metin" },
        type: "textarea",
        required: true,
      },
      {
        key: "maxWords",
        label: { en: "Max words", ar: "أقصى عدد كلمات", tr: "En fazla kelime" },
        type: "number",
      },
    ],
  },
  {
    type: "ai_categorize",
    label: {
      en: "AI · Categorize",
      ar: "AI · تصنيف",
      tr: "AI · Kategorize et",
    },
    description: {
      en: "Classify a text into one of a set of categories.",
      ar: "تصنيف النص ضمن إحدى الفئات.",
      tr: "Metni önceden tanımlanmış kategorilerden birine sınıflandır.",
    },
    category: "crm",
    configFields: [
      {
        key: "text",
        label: { en: "Text", ar: "النص", tr: "Metin" },
        type: "textarea",
        required: true,
      },
      {
        key: "categories",
        label: { en: "Categories (comma-separated)", ar: "الفئات مفصولة بفواصل", tr: "Kategoriler virgülle" },
        type: "text",
        required: true,
        placeholder: "lead, support, complaint, other",
      },
    ],
  },
  {
    type: "ai_translate",
    label: {
      en: "AI · Translate",
      ar: "AI · ترجمة",
      tr: "AI · Çevir",
    },
    description: {
      en: "Translate text to a target language.",
      ar: "ترجمة نص إلى لغة مستهدفة.",
      tr: "Metni hedef dile çevir.",
    },
    category: "messaging",
    configFields: [
      {
        key: "text",
        label: { en: "Text", ar: "النص", tr: "Metin" },
        type: "textarea",
        required: true,
      },
      {
        key: "targetLocale",
        label: { en: "Target language", ar: "اللغة الهدف", tr: "Hedef dil" },
        type: "select",
        options: ["en", "ar", "tr", "fr", "es", "de"],
        required: true,
      },
    ],
  },
  {
    type: "send_notification",
    label: {
      en: "Send in-app notification",
      ar: "إرسال إشعار داخل التطبيق",
      tr: "Uygulama içi bildirim gönder",
    },
    description: {
      en: "Push a bell-icon notification to a specific user.",
      ar: "إرسال إشعار لمستخدم محدد.",
      tr: "Belirli bir kullanıcıya bildirim gönder.",
    },
    category: "crm",
    configFields: [
      {
        key: "userId",
        label: { en: "User ID", ar: "معرّف المستخدم", tr: "Kullanıcı ID" },
        type: "text",
        required: true,
      },
      {
        key: "title",
        label: { en: "Title", ar: "العنوان", tr: "Başlık" },
        type: "text",
        required: true,
      },
      {
        key: "message",
        label: { en: "Body", ar: "النص", tr: "Gövde" },
        type: "textarea",
      },
    ],
  },
  {
    type: "update_field",
    label: {
      en: "Update a field",
      ar: "تحديث حقل",
      tr: "Alan güncelle",
    },
    description: {
      en: "Set one field on a customer / deal / quote / contract.",
      ar: "تعيين حقل على عميل / صفقة / عرض / عقد.",
      tr: "Müşteri / anlaşma / teklif / sözleşme üzerinde bir alanı güncelle.",
    },
    category: "crm",
    configFields: [
      {
        key: "entity",
        label: { en: "Entity", ar: "الكيان", tr: "Varlık" },
        type: "select",
        options: ["customer", "deal", "quote", "contract"],
        required: true,
      },
      {
        key: "entityId",
        label: { en: "Entity ID (or template)", ar: "معرّف الكيان", tr: "Varlık ID" },
        type: "text",
        required: true,
      },
      {
        key: "field",
        label: { en: "Field", ar: "الحقل", tr: "Alan" },
        type: "text",
        required: true,
      },
      {
        key: "value",
        label: { en: "Value", ar: "القيمة", tr: "Değer" },
        type: "text",
      },
    ],
  }
);

// ──────────────────────────────────────────────────────────────────────
// CONDITION OPERATORS
// ──────────────────────────────────────────────────────────────────────

export const CONDITION_OPERATORS = [
  "eq",         // equals (loose)
  "neq",        // not equals
  "gt",         // greater than
  "gte",
  "lt",
  "lte",
  "contains",   // string contains (case-insensitive)
  "startsWith",
  "endsWith",
  "in",         // value is one of a comma-separated list
  "isTrue",     // boolean truthy
  "isFalse",
  "isEmpty",    // null, undefined, "", [], {}
  "isNotEmpty",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const VALID_TRIGGER_TYPES = new Set(TRIGGERS.map((t) => t.type));
export const VALID_ACTION_TYPES = new Set(ACTIONS.map((a) => a.type));
