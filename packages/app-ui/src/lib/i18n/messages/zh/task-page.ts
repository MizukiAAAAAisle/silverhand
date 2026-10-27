import type { taskPage as en } from "../en/task-page";
import type { Translation } from "../../translate";

export const taskPage: Translation<typeof en> = {
  viewInConversation: "在对话中查看",
  showingTheLastLoaded: "刷新失败，显示的是上次加载的版本。",
  taskDetail: "任务详情",
  loadingTask: "正在加载任务",
  editTaskTitle: "编辑任务标题",
  editTitle: "编辑标题",
  noDescription: "无描述。",
  editDescription: "编辑描述",
  taskMetadata: "任务信息",
  tasks: "任务",
  newTask: "新建任务",
  all: "全部",
  tasksIn: "#{channel} 的任务",
};
