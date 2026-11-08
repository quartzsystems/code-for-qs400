// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `object.*`: libraries, objects and object descriptions, each a thin
//! layer over one `Develop` operation (`ListLibraries`, `ListObjects`,
//! `DescribeObject`) in the named connection's session.
//!
//! Names and generic patterns go to the server as typed; the server folds
//! them to upper case. Lists the server pages are drained here, in pages of
//! [`PAGE`], and returned whole.

use std::sync::Arc;

use host_rpc::{Context, Registry, RpcError};
use qap_client::Error;
use qap_client::proto::ops::develop::{LibraryKind, ListLibraries, ListObjects};
use qap_client::proto::types::ObjectName;
use serde::{Deserialize, Serialize};

use crate::session::Sessions;

/// The page size the host asks the server for.
pub const PAGE: u32 = 500;

/// Every entry of a paged list: `page(start, max)` answers the `total`
/// and one page, called until the entries reach the total or a page comes
/// back empty.
pub fn drain<T>(
    mut page: impl FnMut(u32, u32) -> Result<(u32, Vec<T>), Error>,
) -> Result<Vec<T>, Error> {
    let mut out: Vec<T> = Vec::new();
    loop {
        let start = u32::try_from(out.len()).unwrap_or(u32::MAX);
        let (total, entries) = page(start, PAGE)?;
        if entries.is_empty() {
            return Ok(out);
        }
        out.extend(entries);
        if out.len() >= total as usize {
            return Ok(out);
        }
    }
}

/// A name the host must have: trimmed, not empty. Case is the server's to
/// fold.
pub fn required(field: &str, v: &str) -> Result<String, RpcError> {
    let v = v.trim();
    if v.is_empty() {
        return Err(RpcError::invalid_params(format!("{field} is empty")));
    }
    Ok(v.to_owned())
}

/// Params of `object.libraries`.
#[derive(Debug, Deserialize)]
pub struct LibrariesParams {
    pub name: String,
    /// A name, a prefix ending in `*`, or `*ALL`; absent or empty is `*ALL`.
    #[serde(default)]
    pub pattern: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KindDto {
    Production,
    Test,
}

/// An `object.libraries` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryDto {
    pub library: String,
    pub kind: KindDto,
    pub text: String,
}

/// Params of `object.list`.
#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub name: String,
    /// A library, or `*LIBL`, `*CURLIB`, `*USRLIBL`, `*ALL`.
    pub library: String,
    #[serde(default)]
    pub pattern: Option<String>,
    /// Object types (`*FILE`); absent or empty is every type.
    #[serde(default)]
    pub types: Option<Vec<String>>,
    /// The attribute (`PF-SRC`, `RPGLE`); absent is any.
    #[serde(default)]
    pub attribute: Option<String>,
}

/// An `object.list` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectDto {
    pub library: String,
    pub object: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub attribute: String,
    pub text: String,
    /// Bytes.
    pub size: u64,
    /// Milliseconds since 1970-01-01 UTC, as QAP sends times.
    pub changed: i64,
    pub owner: String,
}

/// Params of `object.properties`.
#[derive(Debug, Deserialize)]
pub struct PropertiesParams {
    pub name: String,
    pub library: String,
    pub object: String,
    #[serde(rename = "type")]
    pub ty: String,
}

/// An `object.properties` line: the server's label and the text
/// `DSPOBJD` shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PropertyDto {
    pub name: String,
    pub value: String,
}

impl Sessions {
    /// `object.libraries`: `ListLibraries`, every page.
    pub fn libraries(&self, p: LibrariesParams) -> Result<Vec<LibraryDto>, RpcError> {
        let pattern = p.pattern.unwrap_or_default();
        let all = self.develop(&p.name, |d| {
            drain(|start, max| {
                let page = d.list_libraries(&ListLibraries {
                    pattern: pattern.clone(),
                    start,
                    max,
                })?;
                Ok((page.total, page.libraries))
            })
        })?;
        Ok(all
            .into_iter()
            .map(|l| LibraryDto {
                library: l.name,
                kind: match l.kind {
                    LibraryKind::Production => KindDto::Production,
                    LibraryKind::Test => KindDto::Test,
                },
                text: l.text,
            })
            .collect())
    }

    /// `object.list`: `ListObjects`, every page.
    pub fn objects(&self, p: ListParams) -> Result<Vec<ObjectDto>, RpcError> {
        let library = required("library", &p.library)?;
        let pattern = p.pattern.unwrap_or_default();
        let types = p.types.unwrap_or_default();
        let attribute = p.attribute;
        let all = self.develop(&p.name, |d| {
            drain(|start, max| {
                let page = d.list_objects(&ListObjects {
                    library: library.clone(),
                    pattern: pattern.clone(),
                    types: types.clone(),
                    attribute: attribute.clone(),
                    start,
                    max,
                })?;
                Ok((page.total, page.objects))
            })
        })?;
        Ok(all
            .into_iter()
            .map(|o| ObjectDto {
                library: o.library,
                object: o.name,
                ty: o.r#type,
                attribute: o.attribute,
                text: o.text,
                size: o.size,
                changed: o.changed,
                owner: o.owner,
            })
            .collect())
    }

    /// `object.properties`: `DescribeObject`, in the server's order.
    pub fn properties(&self, p: PropertiesParams) -> Result<Vec<PropertyDto>, RpcError> {
        let object = ObjectName {
            library: required("library", &p.library)?,
            name: required("object", &p.object)?,
        };
        let ty = required("type", &p.ty)?;
        let attrs = self.develop(&p.name, |d| d.describe_object(&object, &ty))?;
        Ok(attrs
            .into_iter()
            .map(|a| PropertyDto {
                name: a.name,
                value: a.value,
            })
            .collect())
    }
}

/// Registers `object.*`.
pub fn register(r: &mut Registry, sessions: &Arc<Sessions>) {
    let s = Arc::clone(sessions);
    r.register(
        "object.libraries",
        move |p: LibrariesParams, _: &Context| s.libraries(p),
    );
    let s = Arc::clone(sessions);
    r.register("object.list", move |p: ListParams, _: &Context| {
        s.objects(p)
    });
    let s = Arc::clone(sessions);
    r.register(
        "object.properties",
        move |p: PropertiesParams, _: &Context| s.properties(p),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_asks_page_by_page_until_the_total() {
        let mut asked = Vec::new();
        let all = drain(|start, max| {
            asked.push((start, max));
            let n = (1200 - start).min(max);
            Ok((1200, (start..start + n).collect::<Vec<u32>>()))
        })
        .unwrap();
        assert_eq!(all.len(), 1200);
        assert_eq!(asked, [(0, 500), (500, 500), (1000, 500)]);
    }

    #[test]
    fn drain_stops_on_an_empty_page() {
        // The list shrank while it was read: the total said more.
        let mut calls = 0;
        let all = drain(|start, _| {
            calls += 1;
            Ok((10, if start == 0 { vec![1, 2, 3] } else { vec![] }))
        })
        .unwrap();
        assert_eq!((all, calls), (vec![1, 2, 3], 2));
        assert!(drain(|_, _| Ok((0, Vec::<u8>::new()))).unwrap().is_empty());
    }
}
