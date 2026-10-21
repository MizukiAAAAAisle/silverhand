import type { en } from "../en";
import type { Translation } from "../../translate";
import { common } from "./common";
import { settings } from "./settings";
import { appShell } from "./app-shell";
import { agents } from "./agents";
import { conversationShell } from "./conversation-shell";
import { messages } from "./messages";
import { workspaces } from "./workspaces";
import { tasks } from "./tasks";
import { chat } from "./chat";
import { computers } from "./computers";
import { channels } from "./channels";
import { agentPage } from "./agent-page";
import { search } from "./search";
import { profile } from "./profile";
import { ui } from "./ui";
import { taskPage } from "./task-page";
import { activity } from "./activity";
import { me } from "./me";
import { identity } from "./identity";
import { conversations } from "./conversations";
import { directPairs } from "./direct-pairs";
import { attention } from "./attention";
import { appUpdate } from "./app-update";
import { avatarMaker } from "./avatar-maker";

export const zh: Translation<typeof en> = {
  common,
  settings,
  appShell,
  agents,
  conversationShell,
  messages,
  workspaces,
  tasks,
  chat,
  computers,
  channels,
  agentPage,
  search,
  profile,
  ui,
  taskPage,
  activity,
  me,
  identity,
  conversations,
  directPairs,
  attention,
  appUpdate,
  avatarMaker,
};
