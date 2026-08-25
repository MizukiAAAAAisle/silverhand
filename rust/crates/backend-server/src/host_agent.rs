//! Compile-only bootstrap scaffold for the host-agent management-plane routes.
//!
//! This module exists ONLY to resolve the crate-root declaration so the
//! host-agent route track (#2195) can add real route modules on top of a
//! commit that already compiles. It is NON-CANONICAL: it declares no routes,
//! exposes no `router()` factory, and is deliberately NOT merged into the
//! composition root — an empty mount would add no reachable route while
//! falsely signalling "already wired".
//!
//! The route track replaces this scaffold with real handlers and a non-empty
//! `router()`; the composition-root mount lands in the same batch as that
//! router, carried by a real route checksum and E2E.
