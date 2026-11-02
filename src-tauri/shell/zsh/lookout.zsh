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

# Marks for Lookout's notifications when a long command finishes: OSC 7701
# "start;<command line>" before a command runs and "end;<exit status>" when the
# prompt comes back. xterm.js reads them without showing anything.
autoload -Uz add-zsh-hook
_lookout_preexec() {
  local line=${1//[[:cntrl:]]/ }
  printf '\e]7701;start;%s\a' "${line[1,300]}"
}
_lookout_precmd() {
  printf '\e]7701;end;%s\a' "$?"
}
add-zsh-hook preexec _lookout_preexec
precmd_functions=(_lookout_precmd $precmd_functions)

# Claude Code started here loads claude-settings.json, whose Stop and
# Notification hooks write the hook's JSON to this terminal as OSC 7701
# "claude;<base64>". Lookout then knows when Claude is done or waiting. The
# user's own settings and hooks load as usual.
export LOOKOUT_TTY=$TTY
typeset -g _lookout_claude_settings=${LOOKOUT_ZDOTDIR:h}/claude-settings.json
if (( ! $+functions[claude] )); then
  function claude {
    command claude --settings "$_lookout_claude_settings" "$@"
  }
fi
