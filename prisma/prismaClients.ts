import { PrismaClient } from "@prisma/client";

let prisma = new PrismaClient();
await prisma.$executeRaw`SET TIME ZONE 'Asia/Shanghai'`;

export default prisma;
