// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

//! `jobs.*`, `spool.*` and `messages.*` at the method-registry level,
//! against canned replies. The fake implements the host's `WorkBackend`
//! (one `qap-client` call per method) with canned lists and refusals; a
//! refusal is `qap-client`'s own `Error::Status` with the server's message,
//! which must come back unchanged. What the host sends is read back from
//! the outbound stream. Messages carry the IDs and texts QS/400's commands
//! send (`CPF1321`, `CPF1343`, `CPF2204`, `CPF1362`).

mod common;

use common::*;
use qap_client::Status;
use qap_client::proto::ops::jobs::JobState;
use serde_json::json;

// jobs.list

#[test]
fn list_drains_every_job_in_the_servers_order() {
    let h = Host::new();
    h.script().jobs = (0..1203)
        .map(|i| {
            let state = match i % 3 {
                0 => JobState::Active,
                1 => JobState::OnJobQueue,
                _ => JobState::OnOutputQueue,
            };
            job_entry(
                &format!("{:06}", 100000 + i),
                "CWELLMAN",
                "QPADEV0001",
                state,
            )
        })
        .collect();
    let out = h
        .call("jobs.list", json!({"name":"QSHQ400","user":"*CURRENT"}))
        .unwrap();
    let jobs = out.as_array().unwrap();
    assert_eq!(jobs.len(), 1203);
    assert_eq!(
        jobs[1],
        json!({
            "job":{"number":"100001","user":"CWELLMAN","name":"QPADEV0001"},
            "state":"onJobQueue","status":"*JOBQ","type":"BATCH","subsystem":"",
            "function":"","entered":1_762_560_000_000_i64
        })
    );
    assert_eq!(h.asked(), vec!["all_jobs *CURRENT None"]);
}

#[test]
fn list_passes_user_and_state() {
    let h = Host::new();
    h.call(
        "jobs.list",
        json!({"name":"QSHQ400","user":"QSYS","state":"active"}),
    )
    .unwrap();
    h.call("jobs.list", json!({"name":"QSHQ400","user":"*ALL"}))
        .unwrap();
    assert_eq!(
        h.asked(),
        vec!["all_jobs QSYS Some(Active)", "all_jobs *ALL None"]
    );
    let e = h
        .call(
            "jobs.list",
            json!({"name":"QSHQ400","user":"*ALL","state":"held"}),
        )
        .unwrap_err();
    assert_eq!(e.code, -32602);
    let e = h
        .call("jobs.list", json!({"name":"QSHQ400","user":" "}))
        .unwrap_err();
    assert_eq!(e.code, -32602);
    assert!(h.asked().is_empty());
}

#[test]
fn another_users_jobs_not_authorized_pass_through() {
    let h = Host::new();
    h.refuse(
        "all_jobs",
        Status::NotAuthorized,
        message(
            "CPF1343",
            40,
            "Job 000000/QSYS/* not valid job type for function.",
            "Cause . . . . . :   You need *JOBCTL special authority to work with jobs of other users.",
        ),
    );
    let e = h
        .call("jobs.list", json!({"name":"QSHQ400","user":"QSYS"}))
        .unwrap_err();
    assert_eq!(e.code, -32010);
    assert_eq!(
        e.data.unwrap(),
        json!({
            "status":"NotAuthorized","messageId":"CPF1343",
            "text":"Job 000000/QSYS/* not valid job type for function.",
            "secondLevel":"Cause . . . . . :   You need *JOBCTL special authority to work with jobs of other users."
        })
    );
}

#[test]
fn unknown_profile_is_the_servers_cpf2204() {
    let h = Host::new();
    h.refuse(
        "all_jobs",
        Status::NotFound,
        message("CPF2204", 40, "User profile NOBODY not found.", ""),
    );
    let e = h
        .call("jobs.list", json!({"name":"QSHQ400","user":"NOBODY"}))
        .unwrap_err();
    assert_eq!(e.message, "CPF2204: User profile NOBODY not found.");
    assert_eq!(e.data.unwrap()["status"], json!("NotFound"));
}

#[test]
fn jobs_below_version_8_send_nothing() {
    let h = Host::at(Some(7));
    let e = h
        .call("jobs.list", json!({"name":"QSHQ400","user":"*CURRENT"}))
        .unwrap_err();
    assert_eq!(e.code, -32001);
    assert_eq!(e.data.unwrap(), json!({"version":7}));
    assert!(h.asked().is_empty());
}

// jobs.log

#[test]
fn log_of_a_named_job_drains_oldest_first() {
    let h = Host::new();
    h.script().log = (0..1203).map(log_entry).collect();
    let out = h
        .call(
            "jobs.log",
            json!({"name":"QSHQ400","job":{"number":"654321","user":"CWELLMAN","name":"CODETEST"}}),
        )
        .unwrap();
    let e = out.as_array().unwrap();
    assert_eq!(e.len(), 1203);
    assert_eq!(e[0]["text"], json!("Message 0."));
    assert_eq!(e[1202]["text"], json!("Message 1202."));
    assert_eq!(e[0]["kind"], json!("completion"));
    assert_eq!(e[0]["fromProgram"], json!("QCMD"));
    assert_eq!(
        h.asked(),
        vec![
            "job_log 654321/CWELLMAN/CODETEST 0 500",
            "job_log 654321/CWELLMAN/CODETEST 500 500",
            "job_log 654321/CWELLMAN/CODETEST 1000 500",
        ]
    );
}

#[test]
fn log_of_an_ended_job_without_its_spooled_log_is_not_found() {
    let h = Host::new();
    h.refuse(
        "job_log",
        Status::NotFound,
        message("CPF1321", 40, "Job 654321/CWELLMAN/CODETEST not found.", ""),
    );
    let e = h
        .call(
            "jobs.log",
            json!({"name":"QSHQ400","job":{"number":"654321","user":"CWELLMAN","name":"CODETEST"}}),
        )
        .unwrap_err();
    assert_eq!(e.code, -32010);
    assert_eq!(e.data.unwrap()["messageId"], json!("CPF1321"));
}

#[test]
fn job_params_are_checked_before_anything_is_sent() {
    let h = Host::new();
    for job in [
        json!({"number":"65432","user":"CWELLMAN","name":"CODETEST"}),
        json!({"number":"654321","user":"","name":"CODETEST"}),
        json!({"number":"654321","user":"CWELLMAN"}),
    ] {
        for m in ["jobs.log", "jobs.hold", "jobs.release"] {
            let e = h
                .call(m, json!({"name":"QSHQ400","job":job.clone()}))
                .unwrap_err();
            assert_eq!(e.code, -32602, "{m} {job}");
        }
    }
    assert!(h.asked().is_empty());
}

// jobs.hold, jobs.release, jobs.end

#[test]
fn hold_release_and_end_are_one_call_each() {
    let h = Host::new();
    let job = json!({"number":"654321","user":"CWELLMAN","name":"CODETEST"});
    for m in ["jobs.hold", "jobs.release"] {
        assert_eq!(
            h.call(m, json!({"name":"QSHQ400","job":job.clone()}))
                .unwrap(),
            json!(null)
        );
    }
    h.call(
        "jobs.end",
        json!({"name":"QSHQ400","job":job.clone(),"how":"immediate"}),
    )
    .unwrap();
    h.call(
        "jobs.end",
        json!({"name":"QSHQ400","job":job.clone(),"how":"controlled","delay":30}),
    )
    .unwrap();
    h.call(
        "jobs.end",
        json!({"name":"QSHQ400","job":job.clone(),"how":"controlled"}),
    )
    .unwrap();
    assert_eq!(
        h.asked(),
        vec![
            "hold_job 654321/CWELLMAN/CODETEST",
            "release_job 654321/CWELLMAN/CODETEST",
            "end_job 654321/CWELLMAN/CODETEST Immediate None",
            "end_job 654321/CWELLMAN/CODETEST Controlled Some(30)",
            "end_job 654321/CWELLMAN/CODETEST Controlled None",
        ]
    );
    let e = h
        .call(
            "jobs.end",
            json!({"name":"QSHQ400","job":job,"how":"immediate","delay":10}),
        )
        .unwrap_err();
    assert_eq!(e.code, -32602);
    assert!(h.asked().is_empty());
}

#[test]
fn end_of_a_job_that_has_ended_is_the_escape_message() {
    let h = Host::new();
    h.refuse(
        "end_job",
        Status::Error,
        message(
            "CPF1362",
            40,
            "Job 654321/CWELLMAN/CODETEST has completed.",
            "",
        ),
    );
    let e = h
        .call(
            "jobs.end",
            json!({"name":"QSHQ400","job":{"number":"654321","user":"CWELLMAN","name":"CODETEST"},"how":"immediate"}),
        )
        .unwrap_err();
    assert_eq!(
        e.data.unwrap(),
        json!({"status":"Error","messageId":"CPF1362","text":"Job 654321/CWELLMAN/CODETEST has completed."})
    );
}

#[test]
fn work_on_a_session_that_is_not_signed_on() {
    let h = Host::new();
    let e = h
        .call("jobs.list", json!({"name":"OTHER","user":"*CURRENT"}))
        .unwrap_err();
    assert_eq!(e.code, -32002);
}

// spool.files, spool.queues

use qap_client::proto::ops::spool::{
    OutputQueue, SpoolChange, SpoolStatus, SpoolTarget, SpooledFileChanged,
};
use qap_client::proto::types::ObjectName;
use qap_client::{Watch, WatchEvent};

const COMPILE_JOB: (&str, &str, &str) = ("123456", "QUSER", "QAPCNN");

fn id_json(job: (&str, &str, &str), file: &str, number: u32) -> serde_json::Value {
    json!({"job":{"number":job.0,"user":job.1,"name":job.2},"file":file,"number":number})
}

#[test]
fn files_drain_and_a_job_keeps_its_own() {
    let h = Host::new();
    h.script().files = vec![
        spooled(conn_job(), "QSYSPRT", 7, SpoolStatus::Ready),
        spooled(
            job_id("654321", "CWELLMAN", "CODETEST"),
            "QPJOBLOG",
            1,
            SpoolStatus::Ready,
        ),
        spooled(conn_job(), "QSYSPRT", 8, SpoolStatus::Held),
    ];
    let out = h
        .call(
            "spool.files",
            json!({"name":"QSHQ400","job":{"number":"123456","user":"quser","name":"QAPCNN"}}),
        )
        .unwrap();
    let f = out.as_array().unwrap();
    assert_eq!(f.len(), 2);
    assert_eq!(
        f[1],
        json!({
            "id": id_json(COMPILE_JOB, "QSYSPRT", 8),
            "status":"held","outq":{"library":"QUSRSYS","name":"CWELLMAN"},"user":"CWELLMAN",
            "userData":"ASSETS","formType":"*STD","deviceType":"scs","pages":3,"copies":1,
            "size":4096,"created":ENTERED
        })
    );
    assert_eq!(
        h.asked(),
        vec!["all_spooled_files *CURRENT outq=None status=None form=None data=None"]
    );
}

#[test]
fn files_filters_are_passed_as_typed() {
    let h = Host::new();
    h.call(
        "spool.files",
        json!({"name":"QSHQ400","user":"*ALL","outq":{"library":"QUSRSYS","name":"PRT01"},
               "status":"held","formType":"*STD","userData":"ASSETS"}),
    )
    .unwrap();
    assert_eq!(
        h.asked(),
        vec![
            "all_spooled_files *ALL outq=Some(\"QUSRSYS/PRT01\") status=Some(Held) form=Some(\"*STD\") data=Some(\"ASSETS\")"
        ]
    );
}

#[test]
fn another_users_files_not_authorized_pass_through() {
    let h = Host::new();
    h.refuse(
        "all_spooled_files",
        Status::NotAuthorized,
        message(
            "CPF3303",
            40,
            "File QSYSPRT not found in job 000001/QSYS/SCPF.",
            "",
        ),
    );
    let e = h
        .call("spool.files", json!({"name":"QSHQ400","user":"QSYS"}))
        .unwrap_err();
    assert_eq!(e.code, -32010);
    assert_eq!(
        e.data.unwrap(),
        json!({"status":"NotAuthorized","messageId":"CPF3303","text":"File QSYSPRT not found in job 000001/QSYS/SCPF."})
    );
}

#[test]
fn queues_of_a_library() {
    let h = Host::new();
    h.script().queues = vec![OutputQueue {
        outq: ObjectName {
            library: "QUSRSYS".into(),
            name: "PRT01".into(),
        },
        text: "Printer 1".into(),
        files: 12,
        writer: "PRT01".into(),
        held: false,
    }];
    let out = h
        .call("spool.queues", json!({"name":"QSHQ400","library":"*LIBL"}))
        .unwrap();
    assert_eq!(
        out,
        json!([{"outq":{"library":"QUSRSYS","name":"PRT01"},"text":"Printer 1","files":12,"writer":"PRT01","held":false}])
    );
    assert_eq!(h.asked(), vec!["all_output_queues *LIBL"]);
}

#[test]
fn spool_below_version_3_sends_nothing_and_watches_need_6() {
    let h = Host::at(Some(2));
    let e = h
        .call("spool.files", json!({"name":"QSHQ400"}))
        .unwrap_err();
    assert_eq!((e.code, e.data.unwrap()), (-32001, json!({"version":2})));
    let h = Host::at(Some(5));
    h.call("spool.files", json!({"name":"QSHQ400"})).unwrap();
    let e = h
        .call(
            "spool.watch",
            json!({"name":"QSHQ400","target":{"profile":"*CURRENT"}}),
        )
        .unwrap_err();
    assert_eq!(e.code, -32001);
    assert_eq!(h.asked().len(), 1);
}

// spool.readText

/// Three pages, the first with a 132-column line.
fn three_pages() -> Vec<String> {
    let ruler: String = (1..=132u32)
        .map(|c| char::from(b'0' + (c % 10) as u8))
        .collect();
    vec![
        format!("{ruler}\n  RNF7030 30      42  ASSETQTY is not defined.\n"),
        "Page 2\n".into(),
        "Page 3\n  * * * * *   E N D   O F   C O M P I L A T I O N   * * * * *\n".into(),
    ]
}

#[test]
fn read_text_whole_keeps_columns_and_form_feeds() {
    let h = Host::new();
    h.script().pages = three_pages();
    let out = h
        .call(
            "spool.readText",
            json!({"name":"QSHQ400","id":id_json(COMPILE_JOB, "QSYSPRT", 8)}),
        )
        .unwrap();
    assert_eq!(
        (
            out["pages"].clone(),
            out["firstPage"].clone(),
            out["lastPage"].clone()
        ),
        (json!(3), json!(1), json!(3))
    );
    let text = out["text"].as_str().unwrap();
    let pages: Vec<&str> = text.split('\u{c}').collect();
    assert_eq!(pages.len(), 3);
    assert_eq!(pages[0].lines().next().unwrap().chars().count(), 132);
    assert!(pages[2].contains("E N D   O F   C O M P I L A T I O N"));
    assert_eq!(
        h.asked(),
        vec!["read QSYSPRT(8) 123456/QUSER/QAPCNN Text 1 0"]
    );
}

#[test]
fn read_text_of_a_range_asks_those_pages() {
    let h = Host::new();
    h.script().pages = three_pages();
    let out = h
        .call(
            "spool.readText",
            json!({"name":"QSHQ400","id":id_json(COMPILE_JOB, "QSYSPRT", 8),"firstPage":2,"lastPage":100}),
        )
        .unwrap();
    assert_eq!(
        (out["firstPage"].clone(), out["lastPage"].clone()),
        (json!(2), json!(3))
    );
    assert_eq!(
        out["text"],
        json!(
            "Page 2\n\u{c}Page 3\n  * * * * *   E N D   O F   C O M P I L A T I O N   * * * * *\n"
        )
    );
    assert_eq!(
        h.asked(),
        vec!["read QSYSPRT(8) 123456/QUSER/QAPCNN Text 2 100"]
    );
    let e = h
        .call(
            "spool.readText",
            json!({"name":"QSHQ400","id":id_json(COMPILE_JOB, "QSYSPRT", 8),"firstPage":0}),
        )
        .unwrap_err();
    assert_eq!(e.code, -32602);
    assert!(h.asked().is_empty());
}

#[test]
fn read_text_of_a_file_still_open_is_in_use() {
    let h = Host::new();
    h.refuse(
        "read",
        Status::InUse,
        message(
            "TCP1A57",
            40,
            "Spooled file QSYSPRT number 8 is still open.",
            "",
        ),
    );
    let e = h
        .call(
            "spool.readText",
            json!({"name":"QSHQ400","id":id_json(COMPILE_JOB, "QSYSPRT", 8)}),
        )
        .unwrap_err();
    assert_eq!(e.code, -32010);
    assert_eq!(e.data.unwrap()["status"], json!("InUse"));
}

// Actions

#[test]
fn hold_release_delete_and_move_are_one_action_each() {
    let h = Host::new();
    let id = id_json(COMPILE_JOB, "QSYSPRT", 8);
    h.call(
        "spool.hold",
        json!({"name":"QSHQ400","id":id,"immediately":false}),
    )
    .unwrap();
    h.call(
        "spool.hold",
        json!({"name":"QSHQ400","id":id,"immediately":true}),
    )
    .unwrap();
    h.call("spool.release", json!({"name":"QSHQ400","id":id}))
        .unwrap();
    h.call(
        "spool.move",
        json!({"name":"QSHQ400","id":id,"outq":{"library":"QUSRSYS","name":"PRT01"},"first":true}),
    )
    .unwrap();
    h.call("spool.delete", json!({"name":"QSHQ400","id":id}))
        .unwrap();
    assert_eq!(
        h.asked(),
        vec![
            "hold QSYSPRT(8) 123456/QUSER/QAPCNN immediately=false",
            "hold QSYSPRT(8) 123456/QUSER/QAPCNN immediately=true",
            "release QSYSPRT(8) 123456/QUSER/QAPCNN",
            "move QSYSPRT(8) 123456/QUSER/QAPCNN to QUSRSYS/PRT01 first=true",
            "delete QSYSPRT(8) 123456/QUSER/QAPCNN",
        ]
    );
}

#[test]
fn release_of_a_file_not_held_is_the_servers_cpf3337() {
    let h = Host::new();
    h.refuse(
        "release",
        Status::Error,
        message("CPF3337", 40, "File QSYSPRT number 8 not held.", ""),
    );
    let e = h
        .call(
            "spool.release",
            json!({"name":"QSHQ400","id":id_json(COMPILE_JOB, "QSYSPRT", 8)}),
        )
        .unwrap_err();
    assert_eq!(e.message, "CPF3337: File QSYSPRT number 8 not held.");
}

#[test]
fn an_id_is_checked_before_anything_is_sent() {
    let h = Host::new();
    for id in [
        id_json(COMPILE_JOB, "QSYSPRT", 0),
        id_json(COMPILE_JOB, " ", 1),
        id_json(("12345", "QUSER", "QAPCNN"), "QSYSPRT", 1),
    ] {
        let e = h
            .call("spool.delete", json!({"name":"QSHQ400","id":id}))
            .unwrap_err();
        assert_eq!(e.code, -32602);
    }
    assert!(h.asked().is_empty());
}

// spool.download

fn scratch(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("qs4-spool-{}-{name}", std::process::id()));
    let _ = std::fs::remove_file(&d);
    d
}

#[test]
fn download_as_pdf_starts_with_pdf() {
    let h = Host::new();
    h.script().pages = three_pages();
    let to = scratch("listing.pdf");
    let out = h
        .call(
            "spool.download",
            json!({"name":"QSHQ400","id":id_json(COMPILE_JOB, "QSYSPRT", 8),"format":"pdf","to":to}),
        )
        .unwrap();
    let bytes = std::fs::read(&to).unwrap();
    assert!(bytes.starts_with(b"%PDF"));
    assert_eq!(out, json!({"pages":3,"size":bytes.len()}));
    assert_eq!(
        h.asked(),
        vec!["read QSYSPRT(8) 123456/QUSER/QAPCNN Pdf 1 0"]
    );
    std::fs::remove_file(&to).unwrap();
}

#[test]
fn download_as_text_and_as_scs() {
    let h = Host::new();
    h.script().pages = three_pages();
    let to = scratch("listing.txt");
    h.call(
        "spool.download",
        json!({"name":"QSHQ400","id":id_json(COMPILE_JOB, "QSYSPRT", 8),"format":"text","to":to,"download":"d-text"}),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(&to)
            .unwrap()
            .matches('\u{c}')
            .count(),
        2
    );
    let scs = scratch("listing.scs");
    h.call(
        "spool.download",
        json!({"name":"QSHQ400","id":id_json(COMPILE_JOB, "QSYSPRT", 8),"format":"scs","to":scs}),
    )
    .unwrap();
    assert_eq!(std::fs::read(&scs).unwrap()[..2], [0x2B, 0xD2]);
    // SCS in batches of 25 pages: three pages are one.
    assert_eq!(
        h.asked(),
        vec![
            "read QSYSPRT(8) 123456/QUSER/QAPCNN Text 1 0",
            "read QSYSPRT(8) 123456/QUSER/QAPCNN Scs 1 25"
        ]
    );
    let notes = h.notes();
    assert!(notes.iter().any(|(m, p)| m == "spool.progress"
        && p["download"] == json!("d-text")
        && p["total"] == json!(3)));
    std::fs::remove_file(&to).unwrap();
    std::fs::remove_file(&scs).unwrap();
}

#[test]
fn a_failed_download_leaves_no_file() {
    let h = Host::new();
    h.refuse(
        "read",
        Status::Error,
        message(
            "TCP1A56",
            40,
            "PDF cannot be made of spooled file QSYSPRT.",
            "",
        ),
    );
    let to = scratch("refused.pdf");
    let e = h
        .call(
            "spool.download",
            json!({"name":"QSHQ400","id":id_json(COMPILE_JOB, "QSYSPRT", 8),"format":"pdf","to":to}),
        )
        .unwrap_err();
    assert_eq!(e.data.unwrap()["messageId"], json!("TCP1A56"));
    assert!(!to.exists());
}

// Watches

fn current() -> Watch {
    Watch::Spool(SpoolTarget::User {
        profile: "*CURRENT".into(),
    })
}

fn changed(change: SpoolChange, number: u32, status: SpoolStatus) -> WatchEvent {
    let f = spooled(conn_job(), "QSYSPRT", number, status);
    WatchEvent::SpoolChanged(SpooledFileChanged {
        target: SpoolTarget::User {
            profile: "*CURRENT".into(),
        },
        change,
        id: f.id.clone(),
        file: (change != SpoolChange::Removed).then_some(f),
    })
}

#[test]
fn spool_changed_is_forwarded_as_it_comes() {
    let h = Host::new();
    h.call(
        "spool.watch",
        json!({"name":"QSHQ400","target":{"profile":"*CURRENT"}}),
    )
    .unwrap();
    assert_eq!(h.asked(), vec![format!("watch {:?}", current())]);
    h.notes();
    h.report(vec![
        changed(SpoolChange::Added, 9, SpoolStatus::Ready),
        changed(SpoolChange::Removed, 7, SpoolStatus::Ready),
        WatchEvent::SpoolRewatched(SpoolTarget::User {
            profile: "*CURRENT".into(),
        }),
    ]);
    let notes: Vec<_> = h
        .notes()
        .into_iter()
        .filter(|(m, _)| m == "spool.changed")
        .collect();
    assert_eq!(notes.len(), 3);
    assert_eq!(notes[0].1["name"], json!("QSHQ400"));
    assert_eq!(notes[0].1["target"], json!({"profile":"*CURRENT"}));
    assert_eq!(notes[0].1["change"], json!("added"));
    assert_eq!(notes[0].1["id"], id_json(COMPILE_JOB, "QSYSPRT", 9));
    assert_eq!(notes[0].1["file"]["status"], json!("ready"));
    assert_eq!(notes[1].1["change"], json!("removed"));
    assert!(notes[1].1.get("file").is_none());
    assert_eq!(notes[2].1["change"], json!("rewatched"));
    assert!(notes[2].1.get("id").is_none());
    // Unwatched: the client is told.
    h.call(
        "spool.unwatch",
        json!({"name":"QSHQ400","target":{"profile":"*CURRENT"}}),
    )
    .unwrap();
    assert_eq!(h.asked(), vec![format!("unwatch {:?}", current())]);
    assert!(h.script().watched.is_empty());
}

#[test]
fn events_are_also_taken_after_any_call() {
    let h = Host::new();
    h.call(
        "spool.watch",
        json!({"name":"QSHQ400","target":{"profile":"*CURRENT"}}),
    )
    .unwrap();
    h.notes();
    h.script()
        .events
        .push(changed(SpoolChange::Changed, 8, SpoolStatus::Held));
    h.call("jobs.list", json!({"name":"QSHQ400","user":"*CURRENT"}))
        .unwrap();
    let notes = h.notes();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].1["change"], json!("changed"));
}

fn await_in_background(
    h: &Host,
    params: serde_json::Value,
) -> std::thread::JoinHandle<Result<serde_json::Value, host_rpc::RpcError>> {
    let r = std::sync::Arc::clone(&h.registry);
    let o = h.outbound.clone();
    std::thread::spawn(move || r.dispatch("spool.awaitFile", params, &host_rpc::Context::new(o)))
}

fn until(f: impl Fn() -> bool) {
    for _ in 0..2000 {
        if f() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("not in 2 s");
}

#[test]
fn await_file_answers_the_first_closed_file_of_its_job_and_drops_its_watch() {
    let h = Host::new();
    let t = await_in_background(
        &h,
        json!({"name":"QSHQ400","job":{"number":"123456","user":"QUSER","name":"QAPCNN"},"file":"QSYSPRT"}),
    );
    until(|| h.script().asked.len() >= 2);
    assert_eq!(
        h.asked(),
        vec![
            format!("watch {:?}", current()),
            "all_spooled_files *CURRENT outq=None status=None form=None data=None".into()
        ]
    );
    // Still being written: not yet.
    h.report(vec![changed(SpoolChange::Added, 9, SpoolStatus::Open)]);
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert!(!t.is_finished());
    h.report(vec![changed(SpoolChange::Changed, 9, SpoolStatus::Ready)]);
    let out = t.join().unwrap().unwrap();
    assert_eq!(out["id"], id_json(COMPILE_JOB, "QSYSPRT", 9));
    assert_eq!(h.asked(), vec![format!("unwatch {:?}", current())]);
}

#[test]
fn await_file_finds_what_was_there_before_its_watch() {
    let h = Host::new();
    h.script().files = vec![
        spooled(conn_job(), "QPJOBLOG", 1, SpoolStatus::Ready),
        spooled(conn_job(), "QSYSPRT", 3, SpoolStatus::Ready),
        spooled(conn_job(), "QSYSPRT", 4, SpoolStatus::Ready),
    ];
    let out = h
        .call(
            "spool.awaitFile",
            json!({"name":"QSHQ400","job":{"number":"123456","user":"QUSER","name":"QAPCNN"},"file":"qsysprt"}),
        )
        .unwrap();
    assert_eq!(out["id"]["number"], json!(4));
}

#[test]
fn await_file_times_out_with_null() {
    let h = Host::new();
    let out = h
        .call(
            "spool.awaitFile",
            json!({"name":"QSHQ400","job":{"number":"123456","user":"QUSER","name":"QAPCNN"},"timeoutMs":30}),
        )
        .unwrap();
    assert_eq!(out, json!(null));
    assert!(h.script().watched.is_empty());
}

#[test]
fn a_wait_keeps_the_watch_the_view_lets_go_and_the_view_keeps_it_after_the_wait() {
    let h = Host::new();
    h.call(
        "spool.watch",
        json!({"name":"QSHQ400","target":{"profile":"*CURRENT"}}),
    )
    .unwrap();
    let t = await_in_background(
        &h,
        json!({"name":"QSHQ400","job":{"number":"123456","user":"QUSER","name":"QAPCNN"}}),
    );
    until(|| h.script().asked.len() >= 3);
    h.call(
        "spool.unwatch",
        json!({"name":"QSHQ400","target":{"profile":"*CURRENT"}}),
    )
    .unwrap();
    assert_eq!(
        h.script().watched,
        vec![current()],
        "the wait still wants it"
    );
    h.report(vec![changed(SpoolChange::Added, 9, SpoolStatus::Ready)]);
    t.join().unwrap().unwrap();
    assert!(h.script().watched.is_empty(), "nobody wants it now");
    // The other way round: the view's watch outlives a wait.
    h.call(
        "spool.watch",
        json!({"name":"QSHQ400","target":{"profile":"*CURRENT"}}),
    )
    .unwrap();
    h.call(
        "spool.awaitFile",
        json!({"name":"QSHQ400","job":{"number":"123456","user":"QUSER","name":"QAPCNN"},"timeoutMs":10}),
    )
    .unwrap();
    assert_eq!(h.script().watched, vec![current()]);
}

#[test]
fn a_wait_ends_with_its_session() {
    let h = Host::new();
    let t = await_in_background(
        &h,
        json!({"name":"QSHQ400","job":{"number":"123456","user":"QUSER","name":"QAPCNN"}}),
    );
    until(|| h.script().asked.len() >= 2);
    h.call("session.disconnect", json!({"name":"QSHQ400"}))
        .unwrap();
    assert_eq!(t.join().unwrap().unwrap(), json!(null));
}
