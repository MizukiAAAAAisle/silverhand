import type { conversations as en } from "../en/conversations";
import type { Translation } from "../../translate";

export const conversations: Translation<typeof en> = {
  addMemberToThis: "添加成员到这个对话",
  addMember: "添加成员",
  agents: "Agent",
  humans: "人类",
  searchMembersOrAdd: "搜索成员或添加新成员",
  everyoneIsAlreadyIn: "所有人都已在这个对话中",
  youHaveNoAgents: "没有可添加的 agent 了",
  onlyThePersonWho: "只有这个 agent 的创建者才能把它加入项目。",
  youCanOnlyAdd:
    "你只能添加自己创建的 agent。别人的 agent 需要由创建者添加，加入项目后项目管理员也可以添加。",
  itsComputerIsNot: "它所在的电脑尚未连接。",
  thisCandidateNoLonger: "这个候选已不存在。",
  severalCandidatesShareThis: "有多个候选使用这个名称。",
  thisConversationsMembersAre: "这个对话的成员是固定的，无法修改。",
  thisConversationIsClosed: "这个对话已关闭，无法添加成员。",
  youDontHavePermission: "你没有权限在这里添加成员。",
  thisConversationNoLonger: "这个对话已不存在。",
  cantAddTheMember: "无法添加成员，请重试。",
  addFailedStatus: "无法添加成员(HTTP {status})。",
};
