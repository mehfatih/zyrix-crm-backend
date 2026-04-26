import { prisma } from "../src/config/database";
import { generateAccessToken } from "../src/utils/jwt";

async function main() {
  const user = await prisma.user.findFirst({
    where: { role: { in: ["owner", "admin", "super_admin"] } },
    select: { id: true, email: true, companyId: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  if (!user) {
    console.error("NO_USER_FOUND");
    process.exit(1);
  }
  const token = generateAccessToken(
    {
      userId: user.id,
      companyId: user.companyId,
      email: user.email,
      role: user.role as any,
    },
    { expiresIn: "1h" }
  );
  console.log(JSON.stringify({ user, token }));
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().then(() => process.exit(1));
  });
