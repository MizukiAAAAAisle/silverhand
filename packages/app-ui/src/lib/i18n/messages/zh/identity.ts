import type { identity as en } from "../en/identity";
import type { Translation } from "../../translate";

export const identity: Translation<typeof en> = {
  displayNameCannotBe: "显示名称不能为空。",
  displayNameCannotContain: "显示名称不能包含控制字符或换行。",
  mustStartWithA: "必须以字母开头，只能包含字母、数字、- 和 _。",
  controlAndInvisibleCharacters: "不能包含控制字符或不可见字符。",
  thisNameIsAlready: "这个名称已被占用。",
  checkingAvailability: "正在检查是否可用",
  displayNameTooLong: "显示名称不能超过 {max} 个字符。",
  nameTooLong: "不能超过 {max} 个字符。",
};
