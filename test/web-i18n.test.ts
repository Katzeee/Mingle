import { describe, expect, it } from "vitest";
import { translator } from "../web/src/i18n.ts";

describe("translator", () => {
  it("spaces Chinese from an inserted Latin name, and not from an inserted Chinese one", () => {
    const zh = translator("zh-CN");
    expect(zh("connect.flowTitle", { platform: "Slack" })).toBe("连接到 Slack");
    expect(zh("connect.flowTitle", { platform: "飞书" })).toBe("连接到飞书");
    expect(zh("connection.claimOpen", { platform: "Telegram" })).toBe("在 Telegram 中发送");
    expect(zh("connection.claimOpen", { platform: "微信" })).toBe("在微信中发送");
    expect(zh("access.rule.org", { platform: "飞书", name: "Alex" })).toBe(
      "在飞书上只有你组织里的人能找到它，他们的消息直接交给 Alex。",
    );
    expect(zh("access.rule.org", { platform: "Slack", name: "小助手" })).toBe(
      "在 Slack 上只有你组织里的人能找到它，他们的消息直接交给小助手。",
    );
  });

  it("leaves English as written and inserts each value once", () => {
    const en = translator("en");
    expect(en("connect.flowTitle", { platform: "Feishu" })).toBe("Connect to Feishu");
    expect(en("agent.pausedTitle", { name: "{name}" })).toContain("{name}");
  });
});
