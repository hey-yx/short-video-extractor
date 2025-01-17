import { expect, test } from "bun:test";
import prismaClient from "prisma/prismaClients";

test("Test the prisma connection status", async () => {
  const result = async (): Promise<boolean> => {
    try {
      await prismaClient.$connect();
      return true;
    } catch (error) {
      console.error("Failed to connect to the database:", error);
      return false;
    } finally {
      await prismaClient.$disconnect();
    }
  };
  // expect(await (prismaClient.user.findFirst()) != null).toBe(true);
  expect(await result()).toBe(true);
});
