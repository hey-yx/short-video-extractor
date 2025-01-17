import { expect, test } from "bun:test";
import { sendVerificationEmail } from "./email-sender";

test("Test sending a verification email.", async () => {
  expect(
    await sendVerificationEmail("business@itcox.cn", "yassine", "397678"),
  ).toBe(true);
});
