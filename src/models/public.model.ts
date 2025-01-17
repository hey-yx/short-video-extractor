import { Elysia, t } from "elysia";

export const publicModels = new Elysia().model({
  getEmailCaptcha: t.Object({
    address: t.String({
      format: "email",
      error: "请输入正确的邮箱格式",
    }),
    uname: t.Optional(
      t.String({
        minLength: 3,
        maxLength: 10,
        error: "请输入3-10位的用户名",
      }),
    ),
  }),
});
