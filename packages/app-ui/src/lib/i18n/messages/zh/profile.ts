import type { profile as en } from "../en/profile";
import type { Translation } from "../../translate";

export const profile: Translation<typeof en> = {
  members: "成员",
  message: "发消息",
  humanProfile: "成员资料",
  created: "创建于",
  profile: "资料",
  profileUnavailable: "资料不可用。",
  mon: "一",
  wed: "三",
  fri: "五",
  messageCountIntensity: "消息数量强度",
  less: "少",
  more: "多",
  messageActivityUnavailable: "消息动态不可用。",
  loadingMessageActivity: "正在加载消息动态",
  messageActivity: "消息动态",
  messageActivityPeriod: "消息动态时间段",
  lastYear: "最近一年",
  loadingAgent: "正在加载 agent",
  loadingProfile: "正在加载资料",
  computer: "电脑",
  session: "Session",
  dailyCounts: "{year} 年每日消息数",
  messagesLastYearSuffix: {
    other: "条消息(最近一年)",
  },
  messagesLastYear: {
    other: "最近一年 {total} 条消息",
  },
  messagesInYear: {
    other: "{year} 年 {total} 条消息",
  },
};
