import axios from "axios";

/**
 * 发送原始邮件
 *
 * @param to 收件人邮箱地址
 * @param subject 邮件主题
 * @param html 邮件内容（HTML格式）
 * @returns 发送是否成功
 */
export async function sendRawEmail(
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  const response = await axios.request({
    url: "https://api.zeptomail.com.cn/v1.1/email",
    method: "POST",
    headers: {
      Authorization: Bun.env.EMAIL_TOKEN,
    },
    data: {
      from: {
        address: Bun.env.EMAIL_FROM_ADDR,
        name: Bun.env.EMAIL_FROM_NAME,
      },
      to: [
        {
          email_address: {
            address: to,
            name: to.split("@")[0],
          },
        },
      ],
      subject: subject,
      htmlbody: html,
    },
  });

  /**
   * {
        data: [
          {
            code: "EM_104",
            additional_info: [],
            message: "Email request received",
          }
        ],
        message: "OK",
        request_id: "e3ab.5eaca2320087b57e.m1.9c0a4210-5b1a-11ef-af41-525400ee2bb1.19156a4e0b1",
        object: "email",
      }
   * 
   */

  return response.data.message === "OK";
}

interface EmailTemplateData {
  USERNAME: string;
  OTP: string;
  YEAR: string;
}

export async function sendVerificationEmail(
  to: string,
  username: string,
  otp: string,
): Promise<boolean> {
  const templateData: EmailTemplateData = {
    USERNAME: username,
    OTP: otp,
    YEAR: new Date().getFullYear().toString(),
  };

  let html = await Bun.file("./src/emails/register.html").text();

  // 替换所有模板变量
  Object.entries(templateData).forEach(([key, value]) => {
    html = html.replace(`{{${key}}}`, value);
  });

  return sendRawEmail(to, "知慧flow - 用户注册邮箱验证码", html);
}
