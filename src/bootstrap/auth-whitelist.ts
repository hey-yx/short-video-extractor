import { type ApiResponse } from "@/types/response";

const authWhitelist = [
  "/user/login",
  "/user/register",
  "/wxpay/notify",
  /^\/public\/(.*)$/,
];

/**
 * 判断给定的路径是否在白名单中
 * 该函数遍历一个 authWhitelist 模式数组，判断路径是否匹配其中的任何一个模式
 * 如果路径匹配一个字符串模式或正则表达式模式，则返回 true，表示该路径在白名单中
 *
 * @param path 要检查的路径
 * @return 如果路径在白名单中返回 true，否则返回 false
 */
function isInWhitelist(path: string) {
  for (let pattern of authWhitelist) {
    if (typeof pattern === "string") {
      if (path === pattern) {
        return true;
      }
    } else if (pattern instanceof RegExp) {
      if (pattern.test(path)) {
        return true;
      }
    }
  }
  return false;
}

export default async function ({
  path,
  jwt,
  set,
  bearer,
}: ItcoxTypes.ContextPro): Promise<ApiResponse<null> | undefined> {
  if (!isInWhitelist(path)) {
    if (!bearer) {
      set.status = 401;
      return {
        success: false,
        data: null,
        errorCode: 1001,
        message: "请传入自定义header -> authorization: Bearer { token }",
      };
    }
    if (bearer) {
      // 验证token
      const payload = await jwt.verify(bearer);

      if (!payload) {
        set.status = 401;
        return {
          success: false,
          data: null,
          errorCode: 1002,
          message: "已传入authorization参数，但验证不通过！",
        };
      }
    }
  }
}
