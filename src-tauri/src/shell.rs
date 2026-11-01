//! Startup files for zsh in Lookout's terminals: they load the user's own
//! files and then add a colored prompt and command highlighting (see
//! shell/zsh/lookout.zsh). They are written to the app data folder, since zsh
//! needs them as files.

use std::path::{Path, PathBuf};

const FILES: &[(&str, &str)] = &[
    ("zsh/.zshenv", include_str!("../shell/zsh/.zshenv")),
    ("zsh/.zprofile", include_str!("../shell/zsh/.zprofile")),
    ("zsh/.zshrc", include_str!("../shell/zsh/.zshrc")),
    ("zsh/lookout.zsh", include_str!("../shell/zsh/lookout.zsh")),
    ("zsh-syntax-highlighting/zsh-syntax-highlighting.zsh", include_str!("../shell/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh")),
    ("zsh-syntax-highlighting/.version", include_str!("../shell/zsh-syntax-highlighting/.version")),
    ("zsh-syntax-highlighting/.revision-hash", include_str!("../shell/zsh-syntax-highlighting/.revision-hash")),
    (
        "zsh-syntax-highlighting/highlighters/main/main-highlighter.zsh",
        include_str!("../shell/zsh-syntax-highlighting/highlighters/main/main-highlighter.zsh"),
    ),
];

/// Writes the files under `dir` when they are missing or changed, and returns
/// the folder to start zsh with as its ZDOTDIR.
pub fn install(dir: &Path) -> std::io::Result<PathBuf> {
    for (name, text) in FILES {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).is_ok_and(|current| current == *text) {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, text)?;
    }
    Ok(dir.join("zsh"))
}
