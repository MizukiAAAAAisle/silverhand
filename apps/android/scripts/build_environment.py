"""Select toolchain inputs without forwarding unrelated session credentials."""

KEYS = frozenset({
    'PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'DEVELOPER_DIR', 'SDKROOT', 'TOOLCHAINS', 'JAVA_HOME',
    'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT',
    'ANDROID_AVD_HOME', 'ANDROID_SERIAL',
    'SWIFT_ANDROID_TOOLCHAIN', 'SWIFT_ANDROID_SDK_BUNDLE',
    'SWIFTLY_HOME_DIR', 'SWIFTLY_BIN_DIR', 'SWIFTLY_TOOLCHAINS_DIR',
    'GRADLE_BIN', 'GRADLE_USER_HOME', 'NODE_BIN', 'PNPM_BIN', 'CARGO_BIN', 'OPENSSL_BIN',
    'CARGO_HOME', 'CARGO_TARGET_DIR', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN',
    'SILVERHAND_ANDROID_HOME', 'SILVERHAND_ANDROID_RUN_ROOT', 'SILVERHAND_ANDROID_BUILD',
    'SILVERHAND_ACCEPTANCE_BACKEND', 'SKIP_DYNAMIC_LIBRARIES', 'SKIP_BRIDGE',
    'SKIP_BRIDGE_ANDROID_BUILD_DISABLED', 'SKIP_BRIDGE_ROBOLECTRIC_BUILD_DISABLED',
    'npm_config_manage_package_manager_versions',
})


def build_environment(parent):
    # Return a new mapping: the communication parent's environment is never changed.
    return {key: value for key, value in parent.items() if key in KEYS}
