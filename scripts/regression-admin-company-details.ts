// Regression check for the admin company-details endpoint.
// Signs a 1-minute super_admin JWT locally and hits
// GET /api/admin/companies/:id — any response other than 200
// indicates the bug has regressed.
//
// Run: npx tsx scripts/regression-admin-company-details.ts
// Optionally: API_BASE_URL=https://api.crm.zyrix.co (default) /
//             TARGET_COMPANY_ID=<uuid> (default: first company).

import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const API_BASE_URL = process.env.API_BASE_URL || "https://api.crm.zyrix.co";

async function main() {
  const prisma = new PrismaClient();
  try {
    const sa = await prisma.user.findFirst({
      where: { role: "super_admin", status: "active" },
    });
    if (!sa) {
      console.error("FAIL: no active super_admin user on this DB");
      process.exit(1);
    }

    const companyId =
      process.env.TARGET_COMPANY_ID ||
      (await prisma.company.findFirst({ select: { id: true } }))?.id;
    if (!companyId) {
      console.error("FAIL: no company to target");
      process.exit(1);
    }

    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) {
      console.error("FAIL: JWT_ACCESS_SECRET not set");
      process.exit(1);
    }

    const token = jwt.sign(
      {
        userId: sa.id,
        companyId: sa.companyId,
        email: sa.email,
        role: sa.role,
        type: "access",
      },
      secret,
      { expiresIn: "1m" } as jwt.SignOptions
    );

    const url = `${API_BASE_URL}/api/admin/companies/${companyId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status !== 200) {
      const body = await res.text();
      console.error(`FAIL: expected 200, got ${res.status}`);
      console.error(body.slice(0, 500));
      process.exit(1);
    }

    const json = (await res.json()) as {
      success?: boolean;
      data?: { id?: string };
    };
    if (json.success !== true || json.data?.id !== companyId) {
      console.error("FAIL: unexpected response shape");
      console.error(JSON.stringify(json).slice(0, 500));
      process.exit(1);
    }

    console.log(`PASS: GET ${url} → 200 (id=${json.data.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
