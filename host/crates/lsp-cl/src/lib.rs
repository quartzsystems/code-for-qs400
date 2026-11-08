// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The CL language server: the `cl` front end's `analyze` of CLLE and
//! CLP sources.
//!
//! `Options::files` is left `None`: the formats a `DCLF` declares come
//! from the file object on the system, and no host method reads a
//! file's record formats, so each `DCLF` reports its file as not found,
//! as the front end documents for a compile without the file.

use cl::analysis::{Options, Tree, analyze};
use cl::ast::{Kind, Stmt};
use compdiag::front::{Analysis, Fetch, Source};
use lsp_common::uri::DocSource;
use lsp_common::{Analyzed, Language, Word, WordKind};
use lsp_types::{FoldingRange, FoldingRangeKind};

/// The CL language.
#[derive(Clone, Copy, Debug, Default)]
pub struct Cl;

impl Language for Cl {
    type Ast = Tree;

    fn id(&self) -> &'static str {
        "qs400-cl"
    }

    fn analyze(&self, _doc: &DocSource, source: &Source, _fetch: Fetch<'_>) -> Analysis<Tree> {
        analyze(source, &Options { files: None })
    }

    fn folding(&self, a: &Analyzed<Tree>) -> Vec<FoldingRange> {
        blocks(&a.analysis.ast.program.stmts)
            .into_iter()
            .map(|(first, last)| FoldingRange {
                start_line: first - 1,
                end_line: last - 1,
                kind: Some(FoldingRangeKind::Region),
                ..FoldingRange::default()
            })
            .collect()
    }

    fn words(&self) -> &'static [Word] {
        WORDS
    }

    fn trigger_characters(&self) -> Vec<String> {
        vec!["%".into(), "&".into()]
    }
}

/// Whether a statement opens a block: `PGM`, `DO` and its loops,
/// `SELECT`, `SUBR`, and a `THEN(DO)` or `CMD(DO)` of `IF`, `ELSE`,
/// `WHEN`, `OTHERWISE` and `MONMSG`.
fn opens(s: &Stmt) -> bool {
    let inner_do = |i: &Option<Box<Stmt>>| i.as_ref().is_some_and(|s| opens(s));
    match &s.kind {
        Kind::Pgm(_)
        | Kind::Do
        | Kind::DoWhile(_)
        | Kind::DoUntil(_)
        | Kind::DoFor(..)
        | Kind::Select
        | Kind::Subr(_) => true,
        Kind::If(_, i) | Kind::When(_, i) | Kind::MonMsg(_, _, i) => inner_do(i),
        Kind::Else(i) | Kind::Otherwise(i) => inner_do(i),
        _ => false,
    }
}

fn ends(s: &Stmt) -> bool {
    matches!(
        s.kind,
        Kind::EndDo | Kind::EndSelect | Kind::EndSubr(_) | Kind::EndPgm
    )
}

/// Each block's first and last line (from 1).
#[must_use]
pub fn blocks(stmts: &[Stmt]) -> Vec<(u32, u32)> {
    let mut open: Vec<usize> = Vec::new();
    let mut out = Vec::new();
    for s in stmts {
        if ends(s) {
            if let Some(first) = open.pop()
                && s.line > first
            {
                out.push((line(first), line(s.line)));
            }
        } else if opens(s) {
            open.push(s.line);
        }
    }
    out.sort_unstable();
    out
}

fn line(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

macro_rules! words {
    ($($kind:ident: [$($w:literal)*])*) => { [$($(Word { label: $w, kind: WordKind::$kind }),*),*] };
}

/// The words completion offers. The `cl` front end exports no table of
/// commands or built-ins, so this one is kept here, from the CL
/// reference; use the front end's when it has one.
const WORDS: &[Word] = &words! {
    Command: [
        "PGM" "ENDPGM" "DCL" "DCLF" "DCLPRCOPT" "CHGVAR" "IF" "ELSE" "DO" "ENDDO" "DOWHILE" "DOUNTIL"
        "DOFOR" "LEAVE" "ITERATE" "SELECT" "WHEN" "OTHERWISE" "ENDSELECT" "GOTO" "CALL" "CALLPRC" "TFRCTL"
        "RETURN" "MONMSG" "SUBR" "ENDSUBR" "CALLSUBR" "RTNSUBR" "RCVF" "SNDF" "SNDRCVF" "WAIT" "ENDRCV"
        "CLOSE" "RTVDTAARA" "CHGDTAARA" "DMPCLPGM" "SNDPGMMSG" "RCVMSG" "RMVMSG" "RTVJOBA" "RTVSYSVAL"
        "RTVMBRD" "RTVOBJD" "CHKOBJ" "OVRDBF" "OVRPRTF" "DLTOVR" "CPYF" "CLRPFM" "ADDLIBLE" "RMVLIBLE"
        "CHGJOB" "SBMJOB" "CRTDTAARA" "DLTF" "ALCOBJ" "DLCOBJ" "OPNQRYF" "CLOF"
    ]
    Function: [
        "%SST" "%SUBSTRING" "%BIN" "%BINARY" "%SWITCH" "%ADDRESS" "%ADDR" "%OFFSET" "%OFS" "%CHAR"
        "%DEC" "%INT" "%UINT" "%LEN" "%SIZE" "%TRIM" "%TRIML" "%TRIMR" "%CHECK" "%CHECKR" "%SCAN"
        "%LOWER" "%UPPER" "%PARMS"
    ]
    Register: [
        "*CHAR" "*DEC" "*LGL" "*INT" "*UINT" "*PTR" "*EQ" "*NE" "*GT" "*LT" "*GE" "*LE" "*AND" "*OR"
        "*NOT" "*CAT" "*BCAT" "*TCAT"
    ]
};

/// Serve CL on stdio.
///
/// # Errors
///
/// When the stream breaks.
pub fn serve() -> Result<(), String> {
    lsp_common::serve_stdio(Cl)
}
