//! The `task edit` canonical no-op guard.
//!
//! An edit writes — and only then fires a `task_edit` event and wakes the
//! conversation's agents — exactly when it changes a canonical field. A field
//! left `None` means "leave unchanged"; a `Some` equal to the current value is
//! not a change; a request that changes nothing is a full no-op (no UPDATE, no
//! `last_editor` stamp, no event, no wake) that still reports the current
//! detail. Content set to the empty string IS a real change when it differs —
//! it clears the body.
//!
//! On a real change the witness carries the requested values verbatim (`None` =
//! leave unchanged), matching the persisted `COALESCE(?, column)` bind: a
//! provided field equal to the current value is harmlessly re-set to itself,
//! never dropped, because the change decision — not per-field filtering — is
//! what the wire contract specifies.
//!
//! The no-op rule is enforced by construction, not by convention: the only way
//! to obtain a [`TaskEditChange`] is [`plan_edit`], so a write path that demands
//! one cannot be handed a fabricated "change" that changes nothing.

use super::spec::{TaskContent, TaskTitle};

/// What an edit request resolves to against the current values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EditPlan {
    /// No canonical field changed: no write, no `last_editor` stamp, no event,
    /// no wake.
    NoOp,
    /// At least one canonical field changed.
    Change(TaskEditChange),
}

/// Proof that a real canonical change was decided, carrying the values to bind
/// (`None` = leave that column unchanged).
///
/// The fields are private and there is no public constructor: `plan_edit` is the
/// sole mint. That is the whole point — an `UPDATE` / `last_editor` stamp /
/// `task_edit` event / agent wake fires only downstream of this witness, so the
/// no-op contract cannot be bypassed by a consumer that skips the planner.
///
/// A change witness cannot be fabricated from parts. (The fence asserts only
/// that this does not compile — rustdoc ignores a pinned error code — so the
/// positive control below carries the "and for the right reason" half: it proves
/// the path, the type name and the accessors are live, leaving field privacy as
/// what the failure is about.)
///
/// ```compile_fail
/// use silverhand_backend_core::conversation_messaging::messaging::task::TaskEditChange;
///
/// // error[E0451]: fields `new_title` and `new_content` are private
/// let forged = TaskEditChange { new_title: None, new_content: None };
/// ```
///
/// The same path used positively — so the failure above is field privacy and not
/// a stale import path or a renamed type:
///
/// ```
/// use silverhand_backend_core::conversation_messaging::messaging::task::{EditPlan, TaskContent, TaskTitle, plan_edit};
///
/// let plan = plan_edit(
///     &TaskTitle::parse("old").unwrap(),
///     &TaskContent::empty(),
///     Some(TaskTitle::parse("new").unwrap()),
///     None,
/// );
/// match plan {
///     EditPlan::Change(change) => {
///         assert_eq!(change.new_title().unwrap().as_str(), "new");
///         assert!(change.new_content().is_none());
///     }
///     EditPlan::NoOp => panic!("a changed title is a change"),
/// }
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskEditChange {
    new_title: Option<TaskTitle>,
    new_content: Option<TaskContent>,
}

impl TaskEditChange {
    pub fn new_title(&self) -> Option<&TaskTitle> {
        self.new_title.as_ref()
    }

    pub fn new_content(&self) -> Option<&TaskContent> {
        self.new_content.as_ref()
    }

    /// Both binds at once, for a write path that needs owned values. There is
    /// deliberately no `into_title` / `into_content`: one `UPDATE` carries both
    /// columns, and a half-consuming accessor would silently drop the other.
    pub fn into_parts(self) -> (Option<TaskTitle>, Option<TaskContent>) {
        (self.new_title, self.new_content)
    }
}

/// Decide the edit outcome. `requested_*` are the already-normalized new values
/// (`None` = leave that field unchanged). Independent of the wire precondition
/// that at least one is `Some`: an all-`None` or all-equal request is simply
/// [`EditPlan::NoOp`].
pub fn plan_edit(
    current_title: &TaskTitle,
    current_content: &TaskContent,
    requested_title: Option<TaskTitle>,
    requested_content: Option<TaskContent>,
) -> EditPlan {
    let title_changes = requested_title.as_ref().is_some_and(|t| t != current_title);
    let content_changes = requested_content
        .as_ref()
        .is_some_and(|c| c != current_content);
    if !title_changes && !content_changes {
        EditPlan::NoOp
    } else {
        EditPlan::Change(TaskEditChange {
            new_title: requested_title,
            new_content: requested_content,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn title(s: &str) -> TaskTitle {
        TaskTitle::parse(s).unwrap()
    }

    fn content(s: &str) -> TaskContent {
        TaskContent::parse(s).unwrap()
    }

    #[test]
    fn leaving_both_fields_unchanged_is_a_noop() {
        assert_eq!(
            plan_edit(&title("t"), &content("c"), None, None),
            EditPlan::NoOp
        );
    }

    #[test]
    fn a_provided_field_equal_to_the_current_value_is_not_a_change() {
        assert_eq!(
            plan_edit(&title("same"), &content("body"), Some(title("same")), None),
            EditPlan::NoOp
        );
        assert_eq!(
            plan_edit(&title("t"), &content("body"), None, Some(content("body"))),
            EditPlan::NoOp
        );
        // Both provided, both equal → still a no-op.
        assert_eq!(
            plan_edit(
                &title("t"),
                &content("c"),
                Some(title("t")),
                Some(content("c"))
            ),
            EditPlan::NoOp
        );
    }

    #[test]
    fn a_changed_title_carries_both_requested_fields_verbatim() {
        // Only the title differs, but the provided (equal) content passes
        // through — the persisted COALESCE re-sets it to itself.
        let plan = plan_edit(
            &title("old"),
            &content("c"),
            Some(title("new")),
            Some(content("c")),
        );
        let EditPlan::Change(change) = plan else {
            panic!("a changed title is a change")
        };
        assert_eq!(change.new_title(), Some(&title("new")));
        assert_eq!(change.new_content(), Some(&content("c")));
        // Owned consumption keeps both binds; there is no half-dropping path.
        assert_eq!(
            change.into_parts(),
            (Some(title("new")), Some(content("c")))
        );
    }

    #[test]
    fn clearing_the_body_to_empty_is_a_real_change() {
        let plan = plan_edit(&title("t"), &content("was here"), None, Some(content("")));
        let EditPlan::Change(change) = plan else {
            panic!("clearing a non-empty body is a change")
        };
        assert_eq!(change.new_title(), None);
        assert_eq!(change.new_content(), Some(&content("")));
        // But clearing an already-empty body changes nothing.
        assert_eq!(
            plan_edit(&title("t"), &content(""), None, Some(content(""))),
            EditPlan::NoOp
        );
    }
}
