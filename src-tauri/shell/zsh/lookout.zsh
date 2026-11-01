# Lookout's additions, loaded after the user's .zshrc. They only fill in what
# the user's setup leaves out. The colors are the terminal's ANSI colors, so
# they follow the terminal theme.

# A colored prompt in place of the macOS default "user@host dir %": the folder,
# the git branch, and an arrow that turns red after a failed command.
if [[ $PROMPT == '%n@%m %1~ %# ' ]]; then
  autoload -Uz vcs_info add-zsh-hook
  zstyle ':vcs_info:*' enable git
  zstyle ':vcs_info:git:*' formats ' %F{magenta}%b%f'
  zstyle ':vcs_info:git:*' actionformats ' %F{magenta}%b%f %F{yellow}%a%f'
  add-zsh-hook precmd vcs_info
  setopt prompt_subst
  PROMPT='%B%F{blue}%~%f%b${vcs_info_msg_0_} %(?.%F{green}.%F{red})❯%f '
fi

# Colors the command line while typing: known commands green, unknown red,
# strings yellow, options cyan.
if (( ! $+functions[_zsh_highlight] )); then
  . "$LOOKOUT_ZDOTDIR/../zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
  ZSH_HIGHLIGHT_STYLES[single-hyphen-option]=fg=cyan
  ZSH_HIGHLIGHT_STYLES[double-hyphen-option]=fg=cyan
fi
