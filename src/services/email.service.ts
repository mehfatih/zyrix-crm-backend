import { Resend } from "resend";
import { env } from "../config/env";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const FROM_EMAIL = env.EMAIL_FROM || "Zyrix CRM <noreply@zyrix.co>";

if (resend) {
  console.log("[Email] Resend configured");
} else {
  console.warn("[Email] Resend not configured - emails will not be sent");
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  if (!resend) {
    console.warn("[Email] Resend not configured, skipping email to:", options.to);
    return false;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });

    if (error) {
      console.error("[Email] Resend error:", error);
      return false;
    }

    console.log("[Email] Sent to:", options.to, "ID:", data?.id);
    return true;
  } catch (error) {
    console.error("[Email] Send failed:", error);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// EMAIL TEMPLATES
// ─────────────────────────────────────────────────────────────────────────

export async function sendVerificationEmail(
  email: string,
  fullName: string,
  verificationUrl: string
): Promise<boolean> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #F0F9FF; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #0891B2, #06B6D4); color: white; padding: 40px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { padding: 40px; color: #164E63; }
    .button { display: inline-block; background: #0891B2; color: white !important; padding: 14px 36px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 24px 0; }
    .footer { background: #F9FAFB; padding: 24px; text-align: center; color: #6B7280; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Welcome to Zyrix CRM</h1>
    </div>
    <div class="content">
      <h2 style="color: #0E7490;">Hi ${fullName}!</h2>
      <p>Thanks for signing up for <strong>Zyrix CRM</strong>. Please verify your email address to unlock all features.</p>
      <div style="text-align: center;">
        <a href="${verificationUrl}" class="button">Verify My Email</a>
      </div>
      <p style="color: #475569; font-size: 14px;">Or copy this link:<br><code style="background: #F0F9FF; padding: 4px 8px; border-radius: 4px; word-break: break-all;">${verificationUrl}</code></p>
      <p style="color: #475569; font-size: 14px;">This link expires in 24 hours.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Zyrix CRM - Built for MENA &amp; Turkey</p>
    </div>
  </div>
</body>
</html>
  `;

  return sendEmail({
    to: email,
    subject: "Verify your Zyrix CRM account",
    html,
  });
}

export async function sendPasswordResetEmail(
  email: string,
  fullName: string,
  resetUrl: string
): Promise<boolean> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #F0F9FF; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #0891B2, #06B6D4); color: white; padding: 40px; text-align: center; }
    .content { padding: 40px; color: #164E63; }
    .button { display: inline-block; background: #0891B2; color: white !important; padding: 14px 36px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 24px 0; }
    .footer { background: #F9FAFB; padding: 24px; text-align: center; color: #6B7280; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Password Reset</h1>
    </div>
    <div class="content">
      <h2 style="color: #0E7490;">Hi ${fullName},</h2>
      <p>We received a request to reset your password. Click the button below to set a new one:</p>
      <div style="text-align: center;">
        <a href="${resetUrl}" class="button">Reset My Password</a>
      </div>
      <p style="color: #475569; font-size: 14px;">If you did not request this, ignore this email.</p>
      <p style="color: #475569; font-size: 14px;">This link expires in 1 hour.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Zyrix CRM</p>
    </div>
  </div>
</body>
</html>
  `;

  return sendEmail({
    to: email,
    subject: "Reset your Zyrix CRM password",
    html,
  });
}

export async function sendWelcomeEmail(
  email: string,
  fullName: string,
  companyName: string
): Promise<boolean> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #F0F9FF; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #0891B2, #06B6D4); color: white; padding: 40px; text-align: center; }
    .content { padding: 40px; color: #164E63; }
    .feature { background: #F0F9FF; padding: 16px; border-radius: 8px; margin: 12px 0; border-left: 4px solid #0891B2; }
    .footer { background: #F9FAFB; padding: 24px; text-align: center; color: #6B7280; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Welcome aboard!</h1>
    </div>
    <div class="content">
      <h2 style="color: #0E7490;">Hi ${fullName},</h2>
      <p>Your workspace <strong>${companyName}</strong> is ready to go.</p>
      <h3 style="color: #0E7490;">Here is what you can do next:</h3>
      <div class="feature">Add your first customer</div>
      <div class="feature">Create a deal to track sales</div>
      <div class="feature">Connect WhatsApp for AI-powered extraction (coming soon)</div>
      <div class="feature">Explore Pipeline for visual sales management</div>
      <p>Need help? Reply to this email - we are here for you.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Zyrix CRM</p>
    </div>
  </div>
</body>
</html>
  `;

  return sendEmail({
    to: email,
    subject: "Welcome to Zyrix CRM!",
    html,
  });
}
