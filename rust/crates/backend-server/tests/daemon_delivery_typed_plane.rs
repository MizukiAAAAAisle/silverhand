//! Resident daemon-specific architecture gates for the sealed typed command plane.

use std::{
    fs,
    path::{Path, PathBuf},
};

use syn::{
    Fields, FnArg, Item, ItemFn, ItemStruct, ItemType, ReturnType, Type, UseTree, Visibility,
    visit::{self, Visit},
};

fn src_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn rust_files(root: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, files);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
}

fn is_cfg_test(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        if !attr.path().is_ident("cfg") {
            return false;
        }
        let mut test = false;
        let _ = attr.parse_nested_meta(|meta| {
            test |= meta.path.is_ident("test");
            Ok(())
        });
        test
    })
}

#[derive(Default)]
struct RawCommandCalls {
    count: usize,
}

impl<'ast> Visit<'ast> for RawCommandCalls {
    fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
        if !is_cfg_test(&item.attrs) {
            visit::visit_item_mod(self, item);
        }
    }

    fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
        if call.method == "command" {
            self.count += 1;
        }
        visit::visit_expr_method_call(self, call);
    }
}

fn production_raw_command_calls() -> usize {
    let mut files = Vec::new();
    rust_files(&src_root(), &mut files);
    files
        .into_iter()
        .map(|path| {
            let parsed = syn::parse_file(&fs::read_to_string(path).unwrap()).unwrap();
            let mut calls = RawCommandCalls::default();
            calls.visit_file(&parsed);
            calls.count
        })
        .sum()
}

const FORBIDDEN_FOUNDATION_OWNER_MODULES: &[&str] = &[
    "agent_materialize",
    "agent_profile_mcp_data_plane",
    "application_orchestration",
    "conversation_messaging",
    "daemon_events",
    "host_agent_background",
    "host_control",
    "host_runtime",
    "identity_access",
    "runtime_control",
    "scope_events",
    "scope_runtime_stop",
    "workspace_data_plane",
];

fn use_paths(tree: &UseTree, prefix: &mut Vec<String>, paths: &mut Vec<Vec<String>>) {
    match tree {
        UseTree::Path(path) => {
            prefix.push(path.ident.to_string());
            use_paths(&path.tree, prefix, paths);
            prefix.pop();
        }
        UseTree::Name(name) => {
            let mut path = prefix.clone();
            path.push(name.ident.to_string());
            paths.push(path);
        }
        UseTree::Rename(rename) => {
            let mut path = prefix.clone();
            path.push(rename.ident.to_string());
            paths.push(path);
        }
        UseTree::Glob(_) => paths.push(prefix.clone()),
        UseTree::Group(group) => {
            for tree in &group.items {
                use_paths(tree, prefix, paths);
            }
        }
    }
}

fn forbidden_foundation_owner_imports(file: &syn::File) -> Vec<String> {
    #[derive(Default)]
    struct FoundationImports(Vec<Vec<String>>);

    impl<'ast> Visit<'ast> for FoundationImports {
        fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
            if !is_cfg_test(&item.attrs) {
                visit::visit_item_mod(self, item);
            }
        }

        fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
            if !is_cfg_test(&item.attrs) {
                use_paths(&item.tree, &mut Vec::new(), &mut self.0);
            }
        }
    }

    let mut imports = FoundationImports::default();
    imports.visit_file(file);
    imports
        .0
        .into_iter()
        .filter(|path| {
            (path.first().is_some_and(|root| root == "crate")
                && path.get(1).is_some_and(|owner| {
                    FORBIDDEN_FOUNDATION_OWNER_MODULES.contains(&owner.as_str())
                }))
                || matches!(
                    path.as_slice(),
                    // #task:2281 — the credential vocabulary relocated under the C2
                    // host_runtime namespace, so its canonical path gained the `host_runtime`
                    // segment. The prohibition follows the canonical path exactly (equally
                    // strong): foundation must not import the concrete credential
                    // principal/scope vocabulary. `runtime_delivery` has not relocated and keeps
                    // its flat path.
                    [core, namespace, module, name]
                        if core == "silverhand_backend_core"
                            && namespace == "host_runtime"
                            && module == "runtime_credential"
                            && matches!(name.as_str(), "RuntimePrincipal" | "RuntimeScope")
                )
                || matches!(
                    path.as_slice(),
                    [core, module, name]
                        if core == "silverhand_backend_core"
                            && module == "runtime_delivery"
                            && name == "RuntimeDeliveryFailureReason"
                )
        })
        .map(|path| path.join("::"))
        .collect()
}

#[test]
fn foundation_transport_does_not_import_concrete_context_owners() {
    let transport = syn::parse_file(
        &fs::read_to_string(src_root().join("foundation/daemon_transport.rs")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        forbidden_foundation_owner_imports(&transport),
        Vec::<String>::new()
    );

    let mutation: syn::File =
        syn::parse_str("use crate::host_runtime::daemon_runtime_owner::DaemonRuntimeOwner;")
            .unwrap();
    assert_eq!(
        forbidden_foundation_owner_imports(&mutation),
        ["crate::host_runtime::daemon_runtime_owner::DaemonRuntimeOwner"]
    );

    let core_mutation: syn::File = syn::parse_str(
        "use silverhand_backend_core::{host_runtime::runtime_credential::{RuntimePrincipal, RuntimeScope}, runtime_delivery::RuntimeDeliveryFailureReason};",
    )
    .unwrap();
    assert_eq!(
        forbidden_foundation_owner_imports(&core_mutation),
        [
            "silverhand_backend_core::host_runtime::runtime_credential::RuntimePrincipal",
            "silverhand_backend_core::host_runtime::runtime_credential::RuntimeScope",
            "silverhand_backend_core::runtime_delivery::RuntimeDeliveryFailureReason",
        ]
    );
}

#[test]
fn raw_attachment_dispatch_has_one_production_call_site() {
    assert_eq!(production_raw_command_calls(), 1);

    let mutation: syn::File =
        syn::parse_str("fn bypass(attachment: &Attachment) { attachment.command(raw, timeout); }")
            .unwrap();
    let mut added = RawCommandCalls::default();
    added.visit_file(&mutation);
    assert_ne!(production_raw_command_calls() + added.count, 1);
}

fn named_struct<'a>(file: &'a syn::File, name: &str) -> &'a ItemStruct {
    file.items
        .iter()
        .find_map(|item| match item {
            Item::Struct(item) if item.ident == name => Some(item),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing struct {name}"))
}

fn named_type<'a>(file: &'a syn::File, name: &str) -> &'a ItemType {
    file.items
        .iter()
        .find_map(|item| match item {
            Item::Type(item) if item.ident == name => Some(item),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing type {name}"))
}

fn type_names(ty: &Type) -> Vec<String> {
    struct Names(Vec<String>);
    impl<'ast> Visit<'ast> for Names {
        fn visit_type_path(&mut self, path: &'ast syn::TypePath) {
            self.0.extend(
                path.path
                    .segments
                    .iter()
                    .map(|segment| segment.ident.to_string()),
            );
            visit::visit_type_path(self, path);
        }
    }
    let mut names = Names(Vec::new());
    names.visit_type(ty);
    names.0
}

fn visible_constructor_reopens_kind_and_value(file: &syn::File) -> bool {
    file.items.iter().any(|item| {
        let Item::Impl(item) = item else { return false };
        item.items.iter().any(|member| {
            let syn::ImplItem::Fn(function) = member else {
                return false;
            };
            if matches!(function.vis, Visibility::Inherited) {
                return false;
            }
            let names: Vec<String> = function
                .sig
                .inputs
                .iter()
                .filter_map(|input| match input {
                    FnArg::Typed(input) => Some(type_names(&input.ty)),
                    FnArg::Receiver(_) => None,
                })
                .flatten()
                .collect();
            names.iter().any(|name| name == "IssuedDaemonCommandKind")
                && names.iter().any(|name| name == "Value")
        })
    })
}

fn fields_are_private(item: &ItemStruct) -> bool {
    match &item.fields {
        Fields::Named(fields) => fields
            .named
            .iter()
            .all(|field| matches!(field.vis, Visibility::Inherited)),
        _ => false,
    }
}

fn is_stateless_refusal_admission(item: &ItemType) -> bool {
    let Type::FnPtr(function) = item.ty.as_ref() else {
        return false;
    };
    function.inputs.len() == 1
        && type_names(&function.inputs[0].ty) == ["str"]
        && matches!(
            &function.output,
            ReturnType::Type(_, output) if type_names(output.as_ref()) == ["bool"]
        )
}

#[test]
fn encoded_command_and_transport_request_stay_sealed() {
    let command = syn::parse_file(
        &fs::read_to_string(src_root().join("foundation/daemon_command.rs")).unwrap(),
    )
    .unwrap();
    assert!(fields_are_private(named_struct(
        &command,
        "EncodedDaemonCommand"
    )));
    assert!(!visible_constructor_reopens_kind_and_value(&command));

    let transport = syn::parse_file(
        &fs::read_to_string(src_root().join("foundation/daemon_transport.rs")).unwrap(),
    )
    .unwrap();
    let request = named_struct(&transport, "HostDataPlaneRequest");
    let fields = match &request.fields {
        Fields::Named(fields) => fields,
        _ => panic!("HostDataPlaneRequest must have named fields"),
    };
    let names: Vec<_> = fields
        .named
        .iter()
        .map(|field| field.ident.as_ref().unwrap().to_string())
        .collect();
    assert_eq!(names, ["custody", "command", "timeout"]);

    let mutation: syn::File = syn::parse_str(
        "pub struct EncodedDaemonCommand { pub kind: IssuedDaemonCommandKind, pub params: Value }",
    )
    .unwrap();
    assert!(!fields_are_private(named_struct(
        &mutation,
        "EncodedDaemonCommand"
    )));
}

#[test]
fn pending_correlation_cannot_capture_an_owner_or_lifecycle_state() {
    let command = syn::parse_file(
        &fs::read_to_string(src_root().join("foundation/daemon_command.rs")).unwrap(),
    )
    .unwrap();
    assert!(is_stateless_refusal_admission(named_type(
        &command,
        "CapabilityRefusalAdmission"
    )));

    let transport = syn::parse_file(
        &fs::read_to_string(src_root().join("foundation/daemon_transport.rs")).unwrap(),
    )
    .unwrap();
    let pending = named_struct(&transport, "PendingCommand");
    let Fields::Named(fields) = &pending.fields else {
        panic!("PendingCommand must have named fields");
    };
    let shape: Vec<_> = fields
        .named
        .iter()
        .map(|field| {
            (
                field.ident.as_ref().unwrap().to_string(),
                type_names(&field.ty),
            )
        })
        .collect();
    assert_eq!(
        shape,
        [
            ("kind".into(), vec!["IssuedDaemonCommandKind".into()]),
            (
                "capability_refusal".into(),
                vec!["CapabilityRefusalAdmission".into()],
            ),
            (
                "response".into(),
                vec![
                    "oneshot".into(),
                    "Sender".into(),
                    "Result".into(),
                    "Value".into(),
                    "CommandDispatchError".into(),
                ],
            ),
            ("deadline".into(), vec!["Instant".into()]),
        ]
    );

    let mutation: syn::File = syn::parse_str(
        "type CapabilityRefusalAdmission = Box<dyn Fn(&str) -> bool + Send + Sync>;",
    )
    .unwrap();
    assert!(!is_stateless_refusal_admission(named_type(
        &mutation,
        "CapabilityRefusalAdmission"
    )));
}

#[derive(Default)]
struct EnvelopeShape {
    from_wire_calls: usize,
    whitelist_macros: usize,
    string_literals: Vec<String>,
}

impl<'ast> Visit<'ast> for EnvelopeShape {
    fn visit_expr_path(&mut self, path: &'ast syn::ExprPath) {
        let segments: Vec<_> = path
            .path
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect();
        if segments.ends_with(&["IssuedDaemonCommandKind".into(), "from_wire".into()]) {
            self.from_wire_calls += 1;
        }
        visit::visit_expr_path(self, path);
    }

    fn visit_lit_str(&mut self, literal: &'ast syn::LitStr) {
        self.string_literals.push(literal.value());
    }

    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        if mac.path.is_ident("matches") {
            self.whitelist_macros += 1;
        }
        visit::visit_macro(self, mac);
    }
}

fn envelope_shape(function: &ItemFn) -> EnvelopeShape {
    let mut shape = EnvelopeShape::default();
    shape.visit_block(&function.block);
    shape
}

fn named_function<'a>(file: &'a syn::File, name: &str) -> &'a ItemFn {
    file.items
        .iter()
        .find_map(|item| match item {
            Item::Fn(item) if item.sig.ident == name => Some(item),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing function {name}"))
}

#[test]
fn response_envelope_has_no_command_string_exception() {
    let transport = syn::parse_file(
        &fs::read_to_string(src_root().join("foundation/daemon_transport.rs")).unwrap(),
    )
    .unwrap();
    let shape = envelope_shape(named_function(
        &transport,
        "valid_command_response_envelope",
    ));
    assert_eq!(shape.from_wire_calls, 1);
    assert_eq!(shape.whitelist_macros, 0);
    assert!(shape.string_literals.iter().all(|literal| {
        !literal.starts_with("runtime_")
            && !literal.starts_with("agent_")
            && !literal.starts_with("host_")
            && literal != "mcp_probe"
            && literal != "rotate_token"
    }));

    let mutation: syn::File = syn::parse_str(
        "fn valid_command_response_envelope(kind: &str) -> bool { IssuedDaemonCommandKind::from_wire(kind).is_some() || matches!(kind, \"runtime_start\") }",
    )
    .unwrap();
    let mutated = envelope_shape(named_function(&mutation, "valid_command_response_envelope"));
    assert_eq!(mutated.from_wire_calls, 1);
    assert_eq!(mutated.whitelist_macros, 1);
}
