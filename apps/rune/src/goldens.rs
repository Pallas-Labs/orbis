//! Golden trees: every demo scene, built in the test process as `--scene` builds it, run for
//! 1.5 s of frames, settled, and written as one line per element in `goldens/<scene>.txt`.
//! A change to what any scene shows fails `cargo test`; rewrite the files with
//! `ORBIS_RUNE_UPDATE_GOLDENS=1 cargo test goldens` and read the diff. Layout and text run on the
//! CPU and the clock is frozen, so the trees match on every run, with no GPU.
//!
//! The press tests, which drive the same view, are in `tests.rs`.

use std::fmt::Write as _;
use std::path::PathBuf;

use rune::{Env, Runtime};

use crate::App;

/// The window size scenes and tests draw at.
pub const SIZE: (f32, f32) = (1180.0, 780.0);

/// The checkout this run tests, read at run time: a test binary built in one worktree and run
/// from another writes only where it was run.
fn checkout() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR").map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

/// A runtime on the real view, poll and keys.
pub fn runtime(s: App) -> Runtime<App> {
    let mut rt = Runtime::new(s, crate::shell::view, SIZE, Env::new(true, 1.0));
    rt.poll = Some(crate::poll);
    rt.on_key = Some(crate::on_key);
    rt
}

/// The scene's elements, settled, one line each.
fn tree(apply: fn(&mut App)) -> String {
    let mut s = crate::demo_app();
    apply(&mut s);
    let mut rt = runtime(s);
    for _ in 0..3 {
        rt.frame(0.5);
    }
    rt.settle_all();
    rt.frame(0.0);
    let mut out = String::new();
    for e in rt.elements().iter().filter(|e| !e.exiting) {
        let depth = e.path.matches('/').count();
        let name = e.path.rsplit('/').next().unwrap_or_default();
        let field = |v: &Option<String>| v.as_deref().map_or_else(|| "-".to_owned(), |t| t.replace('\n', "\\n"));
        let [x, y, w, h] = e.rect.map(|v| (v * 10.0).round() / 10.0);
        let color = e.text_color.map_or_else(|| "-".to_owned(), |c| c.hex());
        let _ = writeln!(out, "{:depth$}{name}\t{}\t{}\t{}\t{}\t{x},{y},{w},{h}\t{}\t{color}\t{:.2}", "", e.role, field(&e.key), field(&e.label), field(&e.text), e.fill.hex(), e.opacity);
    }
    out
}

#[test]
fn every_scene_draws_as_its_golden() {
    crate::clock::freeze_here();
    let update = std::env::var_os("ORBIS_RUNE_UPDATE_GOLDENS").is_some();
    let (folder, actual) = (checkout().join("goldens"), checkout().join("target/goldens-actual"));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::create_dir_all(&actual).unwrap();
    let mut differ = Vec::new();
    for (name, apply) in crate::demo::SCENES {
        let got = tree(*apply);
        let path = folder.join(format!("{name}.txt"));
        if update {
            std::fs::write(&path, &got).unwrap();
        } else if std::fs::read_to_string(&path).unwrap_or_default() != got {
            std::fs::write(actual.join(format!("{name}.txt")), &got).unwrap();
            differ.push(*name);
        }
    }
    let names: Vec<String> = crate::demo::SCENES.iter().map(|(n, _)| format!("{n}.txt")).collect();
    let stale: Vec<String> = std::fs::read_dir(&folder).unwrap().filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|f| !names.contains(f)).collect();
    assert!(stale.is_empty(), "goldens/ holds files for no scene: {stale:?}");
    assert!(
        differ.is_empty(),
        "scenes differ from goldens/: {differ:?} (now in target/goldens-actual/; `diff -r goldens target/goldens-actual` shows how). If meant, rewrite with ORBIS_RUNE_UPDATE_GOLDENS=1 cargo test goldens and read the diff."
    );
}
