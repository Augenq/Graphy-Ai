//! Native entry point; identical service to the Python compatibility launcher.
fn main() {
    if let Err(error) = graphy_core::backend_runtime::main_entry(std::env::args().skip(1).collect())
    {
        eprintln!("graphy serve: {error}");
        std::process::exit(1);
    }
}
