# Renderer structure

Start at `app.tsx` for application composition, then choose the owning page:

| Page     | Entry                               |
| -------- | ----------------------------------- |
| Chat     | `pages/chat/chat-shell.tsx`         |
| Activity | `pages/activity/activity-shell.tsx` |
| Task     | `pages/task/task-shell.tsx`         |
| Agent    | `pages/agent/agent-shell.tsx`       |
| Computer | `pages/computer/computer-shell.tsx` |
| Settings | `pages/settings/settings-shell.tsx` |

Imports point one way: `pages` → `features` → shared layers (`components`,
`hooks`, `lib`, `navigation`, `icons`). A page never imports another page.
`layer-direction-fence.test.ts` enforces all three rules.

`pages/<name>` holds what only that page renders: its shell, sidebar, detail
layout, and page-local models. When a second page or a feature needs a module,
move it into the owning feature first.

`features/<domain>` holds entities and behavior that any page may consume:
`agents`, `tasks`, `computers`, `settings`, `channels`, `workspaces`, `messages`,
`users`, `identity`, `attention`, and others. Within a domain, `components` owns
presentation, `hooks` owns React integration, and `model` owns pure decisions and
state helpers. Small domains need not create all three directories. Tests stay
beside the module they exercise.

`features/conversation-shell` owns the conversation surface shared by Chat and
Activity: pane coordination, channel/thread content, attachments, and read state.
`features/messages` owns the message surface inside it: the composer, message
rows, Markdown and inline references, system messages, saved messages, and
lightboxes. `features/channels` holds the message caches and channel-scoped
mutations; `features/conversations` holds pane capabilities, locators, and
conversation identity shared by channels and direct messages.

`features/app-shell` owns application gates, navigation coordination, and place
restore. `features/appearance` applies appearance preferences independently of
the Settings page. `features/session` owns the signed-in viewer;
`features/profile` owns shared profile presentation and human profile views.

`components/layout` contains domain-neutral layout primitives: sidebar, splitters,
panel headers, list geometry, drag-sort primitives, and pane chrome.
`components/common` contains reusable controls. `lib` is for application
infrastructure and domain-neutral helpers. Place business rules and caches with
their domain, even when more than one page consumes them.

`styles/global.css` is the stylesheet entry: themes load first, then the shared
layers in cascade order: `tokens`, `base`, `chrome`, `markdown`, `surfaces`.
`mobile.css` holds compact-layout rules keyed on `[data-layout]`.

Use kebab-case file names and update imports and source-based test paths together.
