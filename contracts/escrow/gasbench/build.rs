// wasmer-vm 5.0.x (inside cosmwasm-vm 3.0.x) imports the unmangled symbol
// `__rust_probestack`. Recent Rust toolchains export compiler-builtins' stack
// probe only under a mangled name, so the final link fails. When
// GASBENCH_PROBESTACK_SYMBOL names the toolchain's own probe, alias it at link
// time; nothing else about the VM changes.
fn main() {
    println!("cargo:rerun-if-env-changed=GASBENCH_PROBESTACK_SYMBOL");
    if let Ok(sym) = std::env::var("GASBENCH_PROBESTACK_SYMBOL") {
        if !sym.is_empty() {
            println!("cargo:rustc-link-arg=-Wl,--defsym=__rust_probestack={sym}");
        }
    }
}
