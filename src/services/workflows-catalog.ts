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
  // userSelect / territorySelect render as pickers in the builder (company
  // users / territories) instead of raw id text inputs.
  type:
    | "text"
    | "number"
    | "select"
    | "textarea"
    | "boolean"
    | "cron"
    | "userSelect"
    | "territorySelect";
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
  category: "messaging" | "crm" | "external" | "assignment" | "flow";
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
    type: "lead.captured",
    label: { en: "Lead captured", ar: "التقاط عميل محتمل", tr: "Potansiyel müşteri yakalandı" },
    description: {
      en: "Fires when a lead is captured from an external source (e.g. Meta Lead Ads)",
      ar: "يعمل عند التقاط عميل محتمل من مصدر خارجي (مثل إعلانات ليدز ميتا)",
      tr: "Harici bir kaynaktan (ör. Meta Lead Ads) bir potansiyel müşteri yakalandığında tetiklenir",
    },
    category: "crm",
    configFields: [
      {
        key: "source",
        label: { en: "Source contains (optional)", ar: "المصدر يحتوي (اختياري)", tr: "Kaynak içerir (isteğe bağlı)" },
        type: "text",
        placeholder: "meta_lead_ad",
        helpText: {
          en: "Leave blank to match any lead source",
          ar: "اتركه فارغاً لمطابقة أي مصدر",
          tr: "Herhangi bir kaynakla eşleştirmek için boş bırakın",
        },
      },
    ],
    payloadFields: [
      "customer.id",
      "customer.fullName",
      "customer.email",
      "customer.phone",
      "customer.source",
      "deal.id",
      "deal.title",
    ],
  },
  {
    type: "tag.added",
    label: { en: "Tag added to customer", ar: "إضافة وسم لعميل", tr: "Müşteriye etiket eklendi" },
    description: {
      en: "Fires when a tag is added to a customer",
      ar: "يعمل عند إضافة وسم إلى عميل",
      tr: "Bir müşteriye etiket eklendiğinde tetiklenir",
    },
    category: "crm",
    configFields: [
      {
        key: "tagName",
        label: { en: "Tag name (optional)", ar: "اسم الوسم (اختياري)", tr: "Etiket adı (isteğe bağlı)" },
        type: "text",
        placeholder: "vip",
        helpText: {
          en: "Leave blank to fire on any tag",
          ar: "اتركه فارغاً ليعمل مع أي وسم",
          tr: "Herhangi bir etikette tetiklemek için boş bırakın",
        },
      },
    ],
    payloadFields: ["customer.id", "customer.fullName", "tag.name"],
  },
  {
    type: "deal.idle",
    label: { en: "Deal gone idle", ar: "صفقة خاملة", tr: "Anlaşma hareketsiz kaldı" },
    description: {
      en: "Fires once when an open deal has had no update for N days (daily scan)",
      ar: "يعمل مرة واحدة عندما لا يطرأ تحديث على صفقة مفتوحة لمدة N يوم (فحص يومي)",
      tr: "Açık bir anlaşma N gün boyunca güncellenmediğinde bir kez tetiklenir (günlük tarama)",
    },
    category: "crm",
    configFields: [
      {
        key: "idleDays",
        label: { en: "Idle days", ar: "أيام الخمول", tr: "Hareketsiz gün" },
        type: "number",
        required: true,
        placeholder: "3",
      },
      {
        key: "stage",
        label: { en: "Only this stage (optional)", ar: "هذه المرحلة فقط (اختياري)", tr: "Yalnızca bu aşama (isteğe bağlı)" },
        type: "text",
        helpText: {
          en: "Leave blank to scan all open deals",
          ar: "اتركه فارغاً لفحص كل الصفقات المفتوحة",
          tr: "Tüm açık anlaşmaları taramak için boş bırakın",
        },
      },
    ],
    payloadFields: [
      "deal.id",
      "deal.title",
      "deal.value",
      "deal.stage",
      "deal.idleDays",
      "customer.id",
      "customer.fullName",
    ],
  },
  {
    type: "product.low_stock",
    label: {
      en: "Product low on stock",
      ar: "مخزون المنتج منخفض",
      tr: "Ürün stoğu düşük",
    },
    description: {
      en: "Fires when a product's on-hand quantity drops to or below its low-stock threshold",
      ar: "يعمل عندما تنخفض كمية المنتج المتوفرة إلى حد التنبيه أو أقل",
      tr: "Bir ürünün eldeki miktarı düşük stok eşiğine veya altına indiğinde tetiklenir",
    },
    category: "crm",
    configFields: [],
    payloadFields: [
      "product.id",
      "product.name",
      "product.sku",
      "product.location",
      "product.qty",
      "product.lowStockThreshold",
    ],
  },
  {
    type: "quote.viewed",
    label: {
      en: "Quote viewed by client",
      ar: "تمت مشاهدة العرض من العميل",
      tr: "Teklif müşteri tarafından görüntülendi",
    },
    description: {
      en: "Fires the first time a customer opens the public quote link",
      ar: "يعمل أول مرة يفتح فيها العميل رابط العرض العام",
      tr: "Müşteri herkese açık teklif bağlantısını ilk açtığında tetiklenir",
    },
    category: "crm",
    configFields: [],
    payloadFields: [
      "quote.id",
      "quote.quoteNumber",
      "quote.title",
      "quote.total",
      "quote.currency",
      "customerId",
      "dealId",
    ],
  },
  {
    type: "quote.accepted",
    label: {
      en: "Quote accepted by client",
      ar: "تم قبول العرض من العميل",
      tr: "Teklif müşteri tarafından kabul edildi",
    },
    description: {
      en: "Fires when a customer accepts the quote from the public page — automate move to Won, stock deduction, thank-you message",
      ar: "يعمل عندما يقبل العميل العرض من الصفحة العامة — لأتمتة النقل إلى مكسوب وخصم المخزون ورسالة شكر",
      tr: "Müşteri herkese açık sayfadan teklifi kabul ettiğinde tetiklenir — Kazanıldı'ya taşıma, stok düşümü, teşekkür mesajı için",
    },
    category: "crm",
    configFields: [],
    payloadFields: [
      "quote.id",
      "quote.quoteNumber",
      "quote.title",
      "quote.total",
      "quote.currency",
      "customerId",
      "dealId",
    ],
  },
  {
    type: "quote.signed",
    label: {
      en: "Quote signed by client",
      ar: "تم توقيع العرض من العميل",
      tr: "Teklif müşteri tarafından imzalandı",
    },
    description: {
      en: "Fires when a customer e-signs the quote on the public page — the signature is stored and stamped on the PDF",
      ar: "يعمل عندما يوقّع العميل العرض إلكترونيًا على الصفحة العامة — يُخزَّن التوقيع ويُختم على PDF",
      tr: "Müşteri herkese açık sayfada teklifi e-imzaladığında tetiklenir — imza saklanır ve PDF'e basılır",
    },
    category: "crm",
    configFields: [],
    payloadFields: [
      "quote.id",
      "quote.quoteNumber",
      "quote.title",
      "quote.total",
      "quote.currency",
      "signerName",
      "signedAtUtc",
      "customerId",
      "dealId",
    ],
  },
  {
    type: "email.opened",
    label: {
      en: "Email opened",
      ar: "تم فتح البريد",
      tr: "E-posta açıldı",
    },
    description: {
      en: "Fires when a tracked CRM email is opened. Use openCount (e.g. ≥ 3) or firstOpen for 'opened N times' rules.",
      ar: "يعمل عند فتح بريد CRM متتبَّع. استخدم openCount (مثلاً ≥ 3) أو firstOpen لقواعد 'فُتح N مرة'.",
      tr: "İzlenen bir CRM e-postası açıldığında tetiklenir. 'N kez açıldı' kuralları için openCount (örn. ≥ 3) veya firstOpen kullanın.",
    },
    category: "crm",
    configFields: [],
    payloadFields: ["emailId", "customerId", "openCount", "firstOpen", "replied"],
  },
  {
    type: "email.clicked",
    label: {
      en: "Email link clicked",
      ar: "تم النقر على رابط البريد",
      tr: "E-posta bağlantısına tıklandı",
    },
    description: {
      en: "Fires when a recipient clicks a tracked link in a CRM email",
      ar: "يعمل عند نقر المستلم على رابط متتبَّع في بريد CRM",
      tr: "Alıcı bir CRM e-postasındaki izlenen bağlantıya tıkladığında tetiklenir",
    },
    category: "crm",
    configFields: [],
    payloadFields: ["emailId", "customerId", "url", "replied"],
  },
  {
    type: "email.bounced",
    label: {
      en: "Email bounced",
      ar: "ارتد البريد",
      tr: "E-posta geri döndü",
    },
    description: {
      en: "Fires when a CRM email hard/soft bounces (from the Resend delivery webhook)",
      ar: "يعمل عند ارتداد بريد CRM (من ويب هوك تسليم Resend)",
      tr: "Bir CRM e-postası geri döndüğünde tetiklenir (Resend teslimat webhook'undan)",
    },
    category: "crm",
    configFields: [],
    payloadFields: ["emailId", "customerId"],
  },
  {
    type: "payment.succeeded",
    label: {
      en: "Payment received",
      ar: "تم استلام الدفعة",
      tr: "Ödeme alındı",
    },
    description: {
      en: "Fires when a customer pays a quote via iyzico or HyperPay",
      ar: "يعمل عندما يدفع العميل عرض سعر عبر iyzico أو HyperPay",
      tr: "Bir müşteri iyzico veya HyperPay ile bir teklifi ödediğinde tetiklenir",
    },
    category: "crm",
    configFields: [],
    payloadFields: ["amount", "currency", "provider", "quoteId"],
  },
  {
    type: "email.replied",
    label: {
      en: "Email replied",
      ar: "تم الرد على البريد",
      tr: "E-postaya yanıt verildi",
    },
    description: {
      en: "Fires when a customer replies to a tracked CRM email (via the Resend inbound webhook)",
      ar: "يعمل عندما يرد العميل على بريد CRM متتبَّع (عبر ويب هوك Resend الوارد)",
      tr: "Bir müşteri izlenen bir CRM e-postasına yanıt verdiğinde tetiklenir (Resend gelen webhook'u)",
    },
    category: "crm",
    configFields: [],
    payloadFields: ["emailId", "customerId", "replyPreview", "repliedAt"],
  },
  {
    type: "form.submitted",
    label: {
      en: "Form submitted",
      ar: "تم إرسال النموذج",
      tr: "Form gönderildi",
    },
    description: {
      en: "Fires when a form flow is submitted (public kiosk or internal wizard) and a contact is created/matched",
      ar: "يعمل عند إرسال نموذج (كشك عام أو معالج داخلي) وإنشاء/مطابقة جهة اتصال",
      tr: "Bir form gönderildiğinde (herkese açık kiosk veya dahili sihirbaz) ve bir kişi oluşturulduğunda tetiklenir",
    },
    category: "crm",
    configFields: [
      {
        key: "formId",
        label: { en: "Form (optional)", ar: "النموذج (اختياري)", tr: "Form (isteğe bağlı)" },
        type: "text",
        helpText: { en: "Blank = any form", ar: "فارغ = أي نموذج", tr: "Boş = herhangi bir form" },
      },
    ],
    payloadFields: ["customer.id", "customer.fullName", "customer.email", "customer.phone", "dealId", "form.id", "form.name"],
  },
  {
    type: "cadence.exited",
    label: {
      en: "Contact exited a cadence",
      ar: "خرج العميل من سلسلة متابعة",
      tr: "Kişi bir kadanstan çıktı",
    },
    description: {
      en: "Fires when a contact leaves a cadence (replied, deal won, manual, or completed)",
      ar: "يعمل عندما يغادر العميل سلسلة متابعة (رد، صفقة مكسوبة، يدوي، أو اكتمال)",
      tr: "Bir kişi kadanstan ayrıldığında tetiklenir (yanıt, kazanılan anlaşma, manuel veya tamamlanma)",
    },
    category: "crm",
    configFields: [],
    payloadFields: ["cadenceId", "contactId", "reason"],
  },
  // ── Service Desk (Sprint 18) ──
  {
    type: "ticket.created",
    label: { en: "Support ticket created", ar: "إنشاء تذكرة دعم", tr: "Destek talebi oluşturuldu" },
    description: {
      en: "Fires when a support ticket is created (auto from a channel or manually)",
      ar: "يعمل عند إنشاء تذكرة دعم (تلقائيًا من قناة أو يدويًا)",
      tr: "Bir destek talebi oluşturulduğunda tetiklenir (kanaldan otomatik veya manuel)",
    },
    category: "crm",
    configFields: [],
    payloadFields: ["ticket.id", "ticket.number", "ticket.subject", "ticket.channel", "ticket.priority", "ticket.status", "customerId"],
  },
  {
    type: "ticket.resolved",
    label: { en: "Support ticket resolved", ar: "حل تذكرة الدعم", tr: "Destek talebi çözüldü" },
    description: {
      en: "Fires when a ticket is marked resolved",
      ar: "يعمل عند وضع علامة محلول على التذكرة",
      tr: "Bir talep çözüldü olarak işaretlendiğinde tetiklenir",
    },
    category: "crm",
    configFields: [],
    payloadFields: ["ticket.id", "ticket.number", "ticket.subject", "ticket.channel", "ticket.priority", "customerId"],
  },
  {
    type: "ticket.sla_breached",
    label: { en: "Ticket SLA breached", ar: "تجاوز اتفاقية الخدمة للتذكرة", tr: "Talep SLA ihlali" },
    description: {
      en: "Fires when a ticket misses its first-response or resolution SLA",
      ar: "يعمل عند تجاوز التذكرة لزمن الرد الأول أو الحل",
      tr: "Bir talep ilk yanıt veya çözüm SLA süresini aştığında tetiklenir",
    },
    category: "crm",
    configFields: [],
    payloadFields: ["ticket.id", "ticket.number", "ticket.subject", "ticket.priority", "breachKind", "customerId"],
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
        label: { en: "Assignee", ar: "الشخص المسؤول", tr: "Atanan kişi" },
        type: "userSelect",
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
    type: "assign_owner",
    label: { en: "Assign owner", ar: "تعيين مالك", tr: "Sahip ata" },
    description: {
      en: "Assigns the triggering record's owner — fixed user, round-robin, or by territory",
      ar: "يعيّن مالك السجل — مستخدم ثابت أو تناوب أو حسب الإقليم",
      tr: "Tetikleyen kaydın sahibini atar — sabit kullanıcı, sıralı dağıtım veya bölgeye göre",
    },
    category: "assignment",
    configFields: [
      {
        key: "mode",
        label: { en: "Mode", ar: "الوضع", tr: "Mod" },
        type: "select",
        required: true,
        options: ["fixed", "round_robin", "territory"],
        helpText: {
          en: "fixed = one user; round_robin = rotate over a pool; territory = match by territory rules",
          ar: "ثابت = مستخدم واحد؛ تناوب = توزيع على مجموعة؛ إقليم = مطابقة حسب قواعد الإقليم",
          tr: "sabit = tek kullanıcı; round_robin = havuz üzerinde döndür; territory = bölge kurallarına göre eşleştir",
        },
      },
      {
        key: "userId",
        label: { en: "User (fixed mode)", ar: "المستخدم (وضع ثابت)", tr: "Kullanıcı (sabit mod)" },
        type: "userSelect",
        helpText: {
          en: "Leave blank to assign to the workflow creator",
          ar: "اتركه فارغاً لتعيينه لمنشئ الـ workflow",
          tr: "İş akışı oluşturucusuna atamak için boş bırakın",
        },
      },
      {
        key: "territoryId",
        label: { en: "Territory (round-robin over members)", ar: "الإقليم (تناوب على الأعضاء)", tr: "Bölge (üyeler arasında sıralı)" },
        type: "territorySelect",
        helpText: {
          en: "In round_robin mode, rotate over this territory's members; leave blank to rotate over all active company users",
          ar: "في وضع التناوب، يتم التوزيع على أعضاء هذا الإقليم؛ اتركه فارغاً للتوزيع على كل مستخدمي الشركة النشطين",
          tr: "round_robin modunda bu bölgenin üyeleri arasında döndürür; tüm aktif şirket kullanıcıları için boş bırakın",
        },
      },
    ],
  },
  {
    type: "wait",
    label: { en: "Wait", ar: "انتظار", tr: "Bekle" },
    description: {
      en: "Pauses the workflow for a set duration before running the next steps",
      ar: "يوقف الـ workflow لمدة محددة قبل تشغيل الخطوات التالية",
      tr: "Sonraki adımları çalıştırmadan önce iş akışını belirli bir süre duraklatır",
    },
    category: "flow",
    configFields: [
      {
        key: "days",
        label: { en: "Days", ar: "أيام", tr: "Gün" },
        type: "number",
      },
      {
        key: "hours",
        label: { en: "Hours", ar: "ساعات", tr: "Saat" },
        type: "number",
      },
      {
        key: "minutes",
        label: { en: "Minutes", ar: "دقائق", tr: "Dakika" },
        type: "number",
      },
    ],
  },
  {
    type: "webhook_out",
    label: { en: "Signed webhook (HMAC)", ar: "webhook موقّع (HMAC)", tr: "İmzalı webhook (HMAC)" },
    description: {
      en: "POSTs the payload with an HMAC-SHA256 signature header and retries up to 2 times",
      ar: "يرسل POST بالمحتوى مع ترويسة توقيع HMAC-SHA256 ويعيد المحاولة حتى مرتين",
      tr: "Yükü HMAC-SHA256 imza başlığıyla POST eder ve en fazla 2 kez yeniden dener",
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
        key: "secret",
        label: { en: "Signing secret", ar: "سر التوقيع", tr: "İmzalama sırrı" },
        type: "text",
        required: true,
        helpText: {
          en: "Used to compute the X-Zyrix-Signature: sha256=… header",
          ar: "يُستخدم لحساب ترويسة X-Zyrix-Signature: sha256=…",
          tr: "X-Zyrix-Signature: sha256=… başlığını hesaplamak için kullanılır",
        },
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
        label: { en: "Recipient", ar: "المستلم", tr: "Alıcı" },
        type: "userSelect",
        helpText: {
          en: "Leave blank to notify the workflow creator",
          ar: "اتركه فارغاً لإشعار منشئ الـ workflow",
          tr: "İş akışı oluşturucusunu bilgilendirmek için boş bırakın",
        },
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

// A step type is valid if it's a built-in action OR a per-company Custom Action
// recipe reference ("recipe:{id}", Sprint 13). Recipe ids are validated against
// the tenant at execution time; here we only accept the well-formed prefix.
export function isValidActionType(type: string): boolean {
  return VALID_ACTION_TYPES.has(type) || /^recipe:[\w-]{6,}$/.test(type);
}
