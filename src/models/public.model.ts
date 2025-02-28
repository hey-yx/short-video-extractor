import { Elysia, t } from "elysia";

export const publicModels = new Elysia().model({
  parseVideo: t.Object({
    url: t.String({
      minLength: 1,
      error: "请输入有效的视频链接",
    }),
  }),
});
