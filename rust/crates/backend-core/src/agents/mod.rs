//! The agent domain's own vocabulary, owned where an agent is described rather
//! than where one happens to be read.
//!
//! A value belongs here when it answers a question about agents themselves — what
//! runtimes exist, for instance — and is therefore shared by every reader: message
//! authorship, the host resource face, direct-pair reads, the runtime catalog and
//! the delivery decoder. Those readers are peers, so none of them may own the set;
//! a vocabulary owned by one reader forces the others to import that reader's
//! namespace to say something that was never about it.

pub mod runtime;
