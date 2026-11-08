// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! A document's analysis, kept for the features: the
//! [`Analysis`] as `analyze` returned it, each source's index, and the
//! URI each source opens at.

use crate::position::TextIndex;
use compdiag::Where;
use compdiag::front::{Analysis, Include};

/// One document's last complete analysis.
pub struct Analyzed<A> {
    /// What `analyze` returned, unchanged.
    pub analysis: Analysis<A>,
    /// Each source's lines, by index into `analysis.sources`.
    pub indexes: Vec<TextIndex>,
    /// Each source's URI; the first is the document's own. `None` for a
    /// source nothing gave a URI for.
    pub uris: Vec<Option<String>>,
}

impl<A> Analyzed<A> {
    /// `analysis` of the document at `uri`, its includes opening at
    /// what `uri_of` gives each.
    pub fn new(
        analysis: Analysis<A>,
        uri: &str,
        uri_of: impl Fn(&Include) -> Option<String>,
    ) -> Self {
        let mut indexes: Vec<TextIndex> = analysis
            .sources
            .iter()
            .map(|s| TextIndex::new(&s.text))
            .collect();
        if indexes.is_empty() {
            indexes.push(TextIndex::new(""));
        }
        let mut uris = vec![None; analysis.sources.len().max(1)];
        uris[0] = Some(uri.to_string());
        for i in &analysis.includes {
            if let Some(k) = i.resolved
                && k > 0
                && k < uris.len()
                && uris[k].is_none()
            {
                uris[k] = uri_of(i);
            }
        }
        Self {
            analysis,
            indexes,
            uris,
        }
    }

    /// The source a diagnostic's `at` names: the document's own first,
    /// then each include; `None` when it is none of them.
    #[must_use]
    pub fn source_of(&self, at: &Where) -> Option<usize> {
        if matches!(at, Where::None) {
            return Some(0);
        }
        self.analysis.sources.iter().position(|s| &s.at == at)
    }

    /// The directive in the document itself that brought source `k` in,
    /// through any number of nested includes.
    #[must_use]
    pub fn top_directive(&self, k: usize) -> Option<&Include> {
        let mut k = k;
        for _ in 0..=self.analysis.includes.len() {
            let i = self
                .analysis
                .includes
                .iter()
                .find(|i| i.resolved == Some(k))?;
            if i.source == 0 {
                return Some(i);
            }
            k = i.source;
        }
        None
    }

    /// The index of source `k` (the document's own when out of range).
    #[must_use]
    pub fn lines_of(&self, k: usize) -> &TextIndex {
        self.indexes.get(k).unwrap_or(&self.indexes[0])
    }
}
