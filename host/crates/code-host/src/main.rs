// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `qs400-code-host`: the sidecar Code for QS/400 drives over stdio.

use clap::{Parser, Subcommand};
use code_host::{LogLevel, VERSION_LINE, log, registry};
use host_rpc::{Exit, Outbound, serve};
use std::io::{self, BufReader};
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "qs400-code-host", version = VERSION_LINE, about = "Code for QS/400 host")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// JSON-RPC 2.0 server on stdin/stdout (the default)
    Serve,
    /// Language server for one language
    Lsp {
        /// Language id
        lang: String,
    },
    /// Debug adapter
    Dap,
}

fn main() -> ExitCode {
    match Cli::parse().command.unwrap_or(Command::Serve) {
        Command::Serve => run_server(),
        Command::Lsp { .. } | Command::Dap => {
            eprintln!("not implemented in this release");
            ExitCode::from(2)
        }
    }
}

fn run_server() -> ExitCode {
    let outbound = Outbound::new(io::stdout());
    // qap-client's own log lines (never a password, a token or a body).
    let sink = outbound.clone();
    qsa_net::log::set_sink(qsa_net::log::Level::Info, move |level, line| {
        let level = match level {
            qsa_net::log::Level::Error => LogLevel::Error,
            qsa_net::log::Level::Warn => LogLevel::Warn,
            _ => LogLevel::Info,
        };
        log(&sink, level, line);
    });
    log(
        &outbound,
        LogLevel::Info,
        format!("qs400-code-host {VERSION_LINE} serving on stdio"),
    );
    let mut stdin = BufReader::new(io::stdin().lock());
    match serve(&registry(&outbound), &mut stdin, outbound) {
        Ok(Exit::Requested) => ExitCode::SUCCESS,
        Ok(Exit::EndOfStream) => {
            eprintln!("[info] stdin closed, exiting");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("[error] transport failed: {e}");
            ExitCode::FAILURE
        }
    }
}
