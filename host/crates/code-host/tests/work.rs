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
