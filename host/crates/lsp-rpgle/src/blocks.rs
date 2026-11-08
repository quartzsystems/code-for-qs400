// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The tree's blocks as places in the document: procedures, data
//! structures and the calculation blocks (`IF`...`ENDIF`, `BEGSR`...
//! `ENDSR`), for folding and for the procedure the cursor is in.
//!
//! `rpgfront`'s tree places things by listing line: the member with each
//! included member's lines after its directive. Its map from listing
//! lines back to sources is its own (`LineMap`, crate-private), so the
//! same map is rebuilt here from what [`Analysis`] gives: every
//! source's lines, and each include's directive line and the source it
//! brought in.
//!
//! [`Analysis`]: compdiag::front::Analysis

use compdiag::front::Analysis;
use rpgfront::ast::{Def, Module, Stmt};

/// Listing line (from 1) to source and line (from 1).
pub struct Listing {
    at: Vec<(usize, u32)>,
}

impl Listing {
    /// The listing of `a`.
    #[must_use]
    pub fn new<A>(a: &Analysis<A>) -> Self {
        let mut at = Vec::new();
        if !a.sources.is_empty() {
            walk(a, 0, &mut at, 0);
        }
        Self { at }
    }

    /// Where listing line `no` is.
    #[must_use]
    pub fn place(&self, no: u32) -> Option<(usize, u32)> {
        let i = usize::try_from(no).ok()?.checked_sub(1)?;
        self.at.get(i).copied()
    }

    /// The document's line (from 1) of listing line `no`, when it is in
    /// the document itself.
    #[must_use]
    pub fn own(&self, no: u32) -> Option<u32> {
        self.place(no).filter(|(s, _)| *s == 0).map(|(_, l)| l)
    }
}

fn walk<A>(a: &Analysis<A>, src: usize, at: &mut Vec<(usize, u32)>, depth: usize) {
    let text = &a.sources[src].text;
    let lines = u32::try_from(text.split_inclusive('\n').count()).unwrap_or(u32::MAX);
    for line in 1..=lines {
        at.push((src, line));
        if depth < 32
            && let Some(k) = a
                .includes
                .iter()
                .find(|i| i.source == src && i.span.line == line)
                .and_then(|i| i.resolved)
            && k != src
            && k < a.sources.len()
        {
            walk(a, k, at, depth + 1);
        }
    }
}

/// A block: its first and last line in the document (from 1), and the
/// procedure it is when it is one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    /// First line.
    pub first: u32,
    /// Last line.
    pub last: u32,
    /// The procedure's name, for a procedure.
    pub procedure: Option<String>,
}

/// Every block of the document itself (blocks of an include are not the
/// document's to fold).
#[must_use]
pub fn blocks(a: &Analysis<Module>) -> Vec<Block> {
    let map = Listing::new(a);
    let mut out = Vec::new();
    let mut push = |first: u32, last: u32, procedure: Option<String>| {
        if let (Some(f), Some(l)) = (map.own(first), map.own(last))
            && l > f
        {
            out.push(Block {
                first: f,
                last: l,
                procedure,
            });
        }
    };
    let m = &a.ast;
    structures(&m.defs, &mut push);
    calcs(&m.calcs, &mut push);
    for p in &m.procs {
        push(p.at.line, p.end.line, Some(p.name.to_ascii_uppercase()));
        if let Some(pi) = &p.pi {
            structures(std::slice::from_ref(pi), &mut push);
        }
        structures(&p.defs, &mut push);
        calcs(&p.calcs, &mut push);
    }
    out.sort_by_key(|b| (b.first, std::cmp::Reverse(b.last)));
    out.dedup_by_key(|b| (b.first, b.last));
    out
}

/// A data structure, prototype or interface: its line to its last
/// subfield's.
fn structures(defs: &[Def], push: &mut impl FnMut(u32, u32, Option<String>)) {
    for d in defs {
        if let Some(last) = d.children.iter().map(|c| c.at.line).max() {
            push(d.at.line, last, None);
            structures(&d.children, push);
        }
    }
}

/// What opens a calculation block, and what ends one.
fn opens(code: &str) -> bool {
    matches!(
        code,
        "IF" | "DO" | "DOW" | "DOU" | "FOR" | "FOR-EACH" | "SELECT" | "MONITOR" | "BEGSR"
    ) || (code.len() == 4
        && ["IF", "DOW", "DOU"].iter().any(|p| code.starts_with(p))
        && !code.starts_with("IFS"))
        || (code.len() == 5 && (code.starts_with("DOW") || code.starts_with("DOU")))
}

fn ends(code: &str) -> bool {
    matches!(
        code,
        "END" | "ENDIF" | "ENDDO" | "ENDFOR" | "ENDSL" | "ENDMON" | "ENDSR" | "ENDCS"
    )
}

/// The calculation blocks: each opener to its end.
fn calcs(stmts: &[Stmt], push: &mut impl FnMut(u32, u32, Option<String>)) {
    let mut open: Vec<u32> = Vec::new();
    for s in stmts {
        let code = s.op.code.as_str();
        if ends(code) {
            if let Some(first) = open.pop() {
                push(first, s.at.line, None);
            }
        } else if opens(code) {
            open.push(s.at.line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openers_and_ends() {
        for c in [
            "IF", "IFEQ", "DOW", "DOWLT", "DOU", "DOUGE", "DO", "FOR", "SELECT", "MONITOR", "BEGSR",
        ] {
            assert!(opens(c), "{c}");
        }
        for c in ["ITER", "EVAL", "ELSE", "WHEN", "CHAIN", "DSPLY"] {
            assert!(!opens(c), "{c}");
        }
        for c in [
            "END", "ENDIF", "ENDDO", "ENDSL", "ENDSR", "ENDMON", "ENDFOR",
        ] {
            assert!(ends(c), "{c}");
        }
    }
}
