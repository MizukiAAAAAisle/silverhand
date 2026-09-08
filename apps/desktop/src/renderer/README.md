# Renderer structure

Start at `App.tsx` for application composition, then choose the owning page:

| Page     | Entry directory           |
| -------- | ------------------------- |
| Chat     | `features/chat-shell`     |
| Activity | `features/activity-shell` |
| Task     | `features/task-shell`     |
| Agent    | `features/agent-shell`    |
| Computer | `features/computer-shell` |
| Settings | `features/settings-shell` |

Within a domain, `components` owns presentation, `hooks` owns React integration,
and `model` owns pure decisions and state helpers. Small domains need not create
all three directories. Tests stay beside the module they exercise.

`features/conversation-shell` owns the conversation surface shared by Chat and
Activity: pane coordination, channel/thread content, attachments, and read state.
A consumer may import an entity component or hook without mounting its page shell.

`components/layout` contains domain-neutral layout primitives: sidebar, splitters,
panel headers, list geometry, and pane chrome. Application-wide navigation and
window chrome also live here. Conversation data and message behavior belong to
conversation features rather than layout.

`components/common` contains reusable controls. `features/profile` owns shared
profile presentation and human profile views; `features/session` owns the signed-in
viewer. `features/app-shell` owns application gates and navigation coordination.
`features/appearance` applies appearance preferences independently of the Settings
page. Other shared domains retain their own names, such as identity, attention,
attachments, and messages.

`lib` is for application infrastructure and domain-neutral helpers. Place business
rules and caches with their domain, even when more than one page consumes them.
Use kebab-case file names and update imports and source-based test paths together.
