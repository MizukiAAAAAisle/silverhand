//! Explicitly inert test aftermath for suites whose subject ends before post-commit effects.

use silverhand_backend_core::conversation_messaging::messaging::SendMessageOutcome;
use silverhand_backend_server::conversation_messaging::messaging::aftermath::SendAftermath;

pub struct NoAftermath;

impl SendAftermath for NoAftermath {
    async fn announce(&self, _outcome: &SendMessageOutcome) {}
}
