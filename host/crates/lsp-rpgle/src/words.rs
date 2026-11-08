// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! The words completion offers. `rpgfront` at the pinned commit exports
//! no table of its operation codes, built-in functions or keywords, so
//! this one is kept here, from the ILE RPG reference; when the front end
//! exports one, use it instead.

use lsp_common::{Word, WordKind};

macro_rules! words {
    ($kind:ident: $($w:literal)*) => { [$(Word { label: $w, kind: WordKind::$kind }),*] };
}

const OPCODES: [Word; 72] = words!(Keyword:
    "ACQ" "BEGSR" "CALLP" "CHAIN" "CLEAR" "CLOSE" "COMMIT" "DEALLOC" "DELETE" "DOU" "DOW" "DSPLY"
    "DUMP" "ELSE" "ELSEIF" "ENDDO" "ENDFOR" "ENDIF" "ENDMON" "ENDSL" "ENDSR" "EVAL" "EVALR" "EVAL-CORR"
    "EXCEPT" "EXFMT" "EXSR" "FEOD" "FOR" "FOR-EACH" "FORCE" "IF" "IN" "ITER" "LEAVE" "LEAVESR"
    "MONITOR" "NEXT" "ON-ERROR" "ON-EXIT" "OPEN" "OTHER" "OUT" "POST" "READ" "READC" "READE" "READP"
    "READPE" "REL" "RESET" "RETURN" "ROLBK" "SELECT" "SETGT" "SETLL" "SND-MSG" "SORTA" "TEST" "UNLOCK"
    "UPDATE" "WHEN" "WHEN-IN" "WHEN-IS" "WRITE" "XML-INTO" "XML-SAX" "DATA-INTO" "DATA-GEN" "SETON" "SETOFF"
    "EXEC SQL");

const DECLARATIONS: [Word; 50] = words!(Keyword:
    "CTL-OPT" "DCL-C" "DCL-DS" "DCL-ENUM" "DCL-F" "DCL-PI" "DCL-PR" "DCL-PROC" "DCL-S" "DCL-SUBF"
    "DCL-PARM" "END-DS" "END-ENUM" "END-PI" "END-PR" "END-PROC" "BINDEC" "CHAR" "DATE" "FLOAT" "GRAPH"
    "IND" "INT" "OBJECT" "PACKED" "POINTER" "TIME" "TIMESTAMP" "UCS2" "UNS" "VARCHAR" "VARGRAPH"
    "VARUCS2" "ZONED" "LIKE" "LIKEDS" "LIKEREC" "DIM" "INZ" "CONST" "VALUE" "OPTIONS" "QUALIFIED"
    "TEMPLATE" "EXTPGM" "EXTPROC" "EXPORT" "STATIC" "BASED" "OVERLAY");

const BUILTINS: [Word; 66] = words!(Function:
    "%ABS" "%ADDR" "%ALLOC" "%BITAND" "%BITNOT" "%BITOR" "%BITXOR" "%CHAR" "%CHECK" "%CHECKR" "%CONCAT"
    "%DATE" "%DAYS" "%DEC" "%DECH" "%DECPOS" "%DIFF" "%DIV" "%EDITC" "%EDITFLT" "%EDITW" "%ELEM" "%EOF"
    "%EQUAL" "%ERROR" "%FIELDS" "%FLOAT" "%FOUND" "%GRAPH" "%HANDLER" "%HOURS" "%INT" "%INTH" "%KDS"
    "%LEN" "%LIST" "%LOOKUP" "%LOWER" "%MAX" "%MIN" "%MINUTES" "%MONTHS" "%MSECONDS" "%NULLIND" "%OCCUR"
    "%OPEN" "%PARMS" "%REALLOC" "%REM" "%REPLACE" "%SCAN" "%SCANR" "%SCANRPL" "%SECONDS" "%SIZE"
    "%SPLIT" "%SQRT" "%STATUS" "%STR" "%SUBARR" "%SUBDT" "%SUBST" "%TIME" "%TRIM" "%UPPER" "%XLATE");

const DIRECTIVES: [Word; 12] = words!(Directive:
    "/COPY" "/INCLUDE" "/IF DEFINED" "/IF NOT DEFINED" "/ELSEIF" "/ELSE" "/ENDIF" "/DEFINE" "/UNDEFINE"
    "/EOF" "/FREE" "/END-FREE");

const SPECIAL: [Word; 16] = words!(Register:
    "*ON" "*OFF" "*BLANKS" "*ZEROS" "*HIVAL" "*LOVAL" "*NULL" "*INLR" "*OMIT" "*NOPASS" "*VARSIZE"
    "*STRING" "*N" "*ALL" "*START" "*END");

/// Every word.
#[must_use]
pub fn all() -> &'static [Word] {
    use std::sync::OnceLock;
    static ALL: OnceLock<Vec<Word>> = OnceLock::new();
    ALL.get_or_init(|| {
        [
            &OPCODES[..],
            &DECLARATIONS[..],
            &BUILTINS[..],
            &DIRECTIVES[..],
            &SPECIAL[..],
        ]
        .concat()
    })
}
