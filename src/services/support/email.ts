// ============================================================================
// SUPPORT — EMAIL (transcript + fallback) — reuses email.service (Resend)
// ----------------------------------------------------------------------------
// Graceful: sendEmail() already returns false (no-op + log) when RESEND_API_KEY
// is missing, so these are safe to call unconditionally. Copy is en/ar/tr and
// the HTML is direction-aware (dir="rtl" for Arabic).
// ============================================================================

import { sendEmail } from "../email.service";

type Locale = "en" | "ar" | "tr";
const pick = (locale: string): Locale =>
  locale === "ar" || locale === "tr" ? locale : "en";

const COPY = {
  en: {
    transcriptSubject: "Your Zyrix support conversation",
    transcriptTitle: "Conversation transcript",
    transcriptIntro: "Here's a copy of your recent conversation with Zyrix Support.",
    fallbackSubject: "We'll get back to you shortly — Zyrix Support",
    fallbackBody:
      "Thanks for reaching out. Our team will reply to you by email shortly. We're sorry for any delay due to high volume.",
    you: "You",
    ai: "Zyrix Assistant",
    human: "Zyrix Support",
    system: "System",
    footer: "Zyrix CRM — we're here to help.",
  },
  ar: {
    transcriptSubject: "محادثة الدعم الخاصة بك في زيريكس",
    transcriptTitle: "نسخة المحادثة",
    transcriptIntro: "إليك نسخة من محادثتك الأخيرة مع دعم زيريكس.",
    fallbackSubject: "سنعاود التواصل معك قريبًا — دعم زيريكس",
    fallbackBody:
      "شكرًا لتواصلك معنا. سيرد عليك فريقنا عبر البريد الإلكتروني قريبًا. نعتذر عن أي تأخير بسبب كثرة الطلبات.",
    you: "أنت",
    ai: "مساعد زيريكس",
    human: "دعم زيريكس",
    system: "النظام",
    footer: "زيريكس CRM — نحن هنا لمساعدتك.",
  },
  tr: {
    transcriptSubject: "Zyrix destek görüşmeniz",
    transcriptTitle: "Görüşme dökümü",
    transcriptIntro: "Zyrix Destek ile yaptığınız son görüşmenin bir kopyası.",
    fallbackSubject: "Kısa süre içinde size döneceğiz — Zyrix Destek",
    fallbackBody:
      "Bize ulaştığınız için teşekkürler. Ekibimiz kısa süre içinde size e-posta ile yanıt verecek. Yoğunluk nedeniyle yaşanan gecikme için özür dileriz.",
    you: "Siz",
    ai: "Zyrix Asistanı",
    human: "Zyrix Destek",
    system: "Sistem",
    footer: "Zyrix CRM — yardım için buradayız.",
  },
} as const;

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function shell(locale: Locale, title: string, inner: string): string {
  const dir = locale === "ar" ? "rtl" : "ltr";
  return `<!DOCTYPE html><html dir="${dir}"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#0A1530;font-family:-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#112044;border-radius:14px;overflow:hidden;border:1px solid #1e3a6b;">
    <div style="background:linear-gradient(135deg,#1A56DB,#22D3EE);padding:28px;color:#fff;">
      <h1 style="margin:0;font-size:22px;">${esc(title)}</h1>
    </div>
    <div style="padding:28px;color:#cdd9f0;font-size:14px;line-height:1.7;">${inner}</div>
    <div style="padding:18px 28px;background:#0d1a38;color:#7c8db5;font-size:12px;text-align:center;">
      ${esc(COPY[locale].footer)}
    </div>
  </div>
</body></html>`;
}

const senderLabel = (locale: Locale, sender: string): string =>
  sender === "user" ? COPY[locale].you
    : sender === "ai" ? COPY[locale].ai
    : sender === "human" ? COPY[locale].human
    : COPY[locale].system;

export async function sendTranscriptEmail(params: {
  to: string;
  locale: string;
  messages: Array<{ sender: string; body: string; createdAt: Date }>;
}): Promise<boolean> {
  const loc = pick(params.locale);
  const c = COPY[loc];
  const align = loc === "ar" ? "right" : "left";
  const rows = params.messages
    .map(
      (m) =>
        `<div style="margin:0 0 12px;text-align:${align};">
           <div style="font-size:11px;color:#22D3EE;font-weight:bold;">${esc(senderLabel(loc, m.sender))}</div>
           <div style="background:#0d1a38;border:1px solid #1e3a6b;border-radius:10px;padding:10px 12px;color:#e6edfb;">${esc(m.body)}</div>
         </div>`
    )
    .join("");
  const inner = `<p>${esc(c.transcriptIntro)}</p><div style="margin-top:16px;">${rows}</div>`;
  return sendEmail({
    to: params.to,
    subject: c.transcriptSubject,
    html: shell(loc, c.transcriptTitle, inner),
  });
}

export async function sendFallbackEmail(params: { to: string; locale: string }): Promise<boolean> {
  const loc = pick(params.locale);
  const c = COPY[loc];
  return sendEmail({
    to: params.to,
    subject: c.fallbackSubject,
    html: shell(loc, c.fallbackSubject, `<p>${esc(c.fallbackBody)}</p>`),
  });
}
