import type { directPairs as en } from "../en/direct-pairs";
import type { Translation } from "../../translate";

export const directPairs: Translation<typeof en> = {
  deletedAgent: "已删除的 agent",
  deletedUser: "已删除的用户",
  loadingConversation: "正在加载对话",
  opensActivity: "打开动态",
  opensProfile: "打开资料",
  message: "发消息…",
  thisConversationIsntAvailable: "你无法访问这个对话。",
  attachAFile: "添加附件",
  sendEnter: "发送 (Enter)",
  sending: "正在发送…",
  send: "发送",
  cantReachTheServer: "无法连接服务器，请检查网络后重试。",
  attachmentsMustBe10: "每个附件不能超过 10 MB。",
  thatMessageIsToo: "消息太长，无法发送。",
  oneOfTheAttachments: "有一个附件无法发送。",
  thatMessageCantBe: "这条消息无法作为私信发送。",
  couldNotSendPlease: "发送失败，请重试。",
  messageNamed: "给 {name} 发消息",
  cantStart: "你无法与 {name} 开始私信。",
  noLongerAvailable: "{name} 已不可用。",
};
