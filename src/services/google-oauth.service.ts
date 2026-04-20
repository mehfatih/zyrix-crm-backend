import { OAuth2Client } from "google-auth-library";
import { randomUUID } from "crypto";
import { env } from "../config/env";
import { prisma } from "../config/database";
import {
  generateAccessToken,
  generateRefreshToken,
  accessTokenExpiresInSeconds,
} from "../utils/jwt";
import { badRequest } from "../middleware/errorHandler";
import type { AuthResponse } from "../types";
import { sendWelcomeEmail } from "./email.service";

const googleClient = env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(env.GOOGLE_CLIENT_ID)
  : null;

export interface GoogleProfile {
  googleId: string;
  email: string;
  fullName: string;
  picture?: string;
  emailVerified: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Verify Google ID token
// ─────────────────────────────────────────────────────────────────────────
export async function verifyGoogleIdToken(
  idToken: string
): Promise<GoogleProfile> {
  if (!googleClient) {
    throw badRequest("Google OAuth is not configured on this server");
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      throw badRequest("Invalid Google token");
    }

    return {
      googleId: payload.sub,
      email: payload.email!,
      fullName: payload.name || payload.email!.split("@")[0],
      picture: payload.picture,
      emailVerified: payload.email_verified || false,
    };
  } catch (error) {
    console.error("[GoogleOAuth] Token verification failed:", error);
    throw badRequest("Failed to verify Google token");
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Slugify helper
// ─────────────────────────────────────────────────────────────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);
}

// ─────────────────────────────────────────────────────────────────────────
// Google Sign-in / Sign-up
// ─────────────────────────────────────────────────────────────────────────
export async function googleSignInOrSignUp(
  idToken: string
): Promise<AuthResponse> {
  const profile = await verifyGoogleIdToken(idToken);

  if (!profile.emailVerified) {
    throw badRequest("Google email is not verified");
  }

  // Check if user already exists
  let user = await prisma.user.findUnique({
    where: { email: profile.email.toLowerCase() },
    include: { company: true },
  });

  let isNewUser = false;

  if (user) {
    // Existing user - update Google ID if missing
    if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: profile.googleId,
          emailVerified: true,
          lastLoginAt: new Date(),
        },
        include: { company: true },
      });
    } else {
      // Just update lastLoginAt
      user = await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
        include: { company: true },
      });
    }
  } else {
    // New user - auto-create company + user
    isNewUser = true;
    const companyName = `${profile.fullName}'s Workspace`;
    let slug = slugify(companyName);

    // Ensure slug uniqueness
    let slugExists = await prisma.company.findUnique({ where: { slug } });
    let counter = 1;
    while (slugExists) {
      slug = `${slugify(companyName)}-${counter}`;
      slugExists = await prisma.company.findUnique({ where: { slug } });
      counter++;
    }

    const result = await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: companyName,
          slug,
          plan: "free",
        },
      });

      const newUser = await tx.user.create({
        data: {
          companyId: company.id,
          email: profile.email.toLowerCase(),
          fullName: profile.fullName,
          googleId: profile.googleId,
          emailVerified: true,
          role: "owner",
          lastLoginAt: new Date(),
        },
        include: { company: true },
      });

      return newUser;
    });

    user = result;
  }

  if (!user) {
    throw new Error("Failed to create or retrieve user");
  }

  // Generate tokens
  const accessToken = generateAccessToken({
    userId: user.id,
    companyId: user.companyId,
    email: user.email,
    role: user.role,
  });

  const tokenId = randomUUID();
  const refreshToken = generateRefreshToken({
    userId: user.id,
    tokenId,
  });

  // Store refresh token
  await prisma.refreshToken.create({
    data: {
      id: tokenId,
      userId: user.id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  // Send welcome email for new users (fire and forget)
  if (isNewUser) {
    sendWelcomeEmail(user.email, user.fullName, user.company.name).catch(
      (err) => console.error("[GoogleOAuth] Welcome email failed:", err)
    );
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      companyId: user.companyId,
      emailVerified: user.emailVerified,
    },
    company: {
      id: user.company.id,
      name: user.company.name,
      slug: user.company.slug,
      plan: user.company.plan,
    },
    tokens: {
      accessToken,
      refreshToken,
      expiresIn: accessTokenExpiresInSeconds,
    },
  };
}
