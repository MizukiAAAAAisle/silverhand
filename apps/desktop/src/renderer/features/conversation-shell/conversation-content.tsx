import type { ConversationPanesModel } from './pane-render-models';
import { PrimaryPaneContent } from './primary-pane-content';
import { SecondaryPaneContent } from './secondary-pane-content';

export function renderConversationPanes(model: ConversationPanesModel) {
  return {
    primary: <PrimaryPaneContent model={model.primary} />,
    secondary:
      model.secondary.kind === 'none' ? null : <SecondaryPaneContent model={model.secondary} />,
  };
}

export type ConversationContent = ReturnType<typeof renderConversationPanes>;
