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

# OSC 7701 "input" when zsh starts reading a command line, where the cursor is
# right after the prompt, so ⌘A in Lookout selects only what is typed.
autoload -Uz add-zle-hook-widget
_lookout_line_init() {
  printf '\e]7701;input\a'
}
add-zle-hook-widget line-init _lookout_line_init

# When another folder opens in the window, Lookout moves terminals that wait at
# the prompt to it. It sends ESC [7701~, the folder and the end of a bracketed
# paste, ESC [201~. The widget reads the folder as a paste into a variable, so
# the command line and its undo stay as they were, and changes to the folder
# only when nothing is typed. The prompt is drawn again in place, so nothing is
# printed and nothing goes into the history.
_lookout_cd() {
  local dir f
  zle .bracketed-paste dir
  [[ -z $BUFFER && $CONTEXT == start && -d $dir && $dir != $PWD ]] || return 0
  builtin cd -- "$dir" &>/dev/null || return 0
  # The prompt hooks run as before any prompt: vcs_info for the git branch,
  # and the user's own.
  for f in precmd $precmd_functions; do
    (( $+functions[$f] )) && $f &>/dev/null
  done
  zle reset-prompt
  zle -R
  # The prompt can be longer or shorter now, so the typed text starts elsewhere.
  printf '\e]7701;input\a'
}
zle -N _lookout_cd
bindkey '\e[7701~' _lookout_cd

# Claude Code started here loads claude-settings.json, whose hooks (session
# start, prompt, tool use, stop and notification) save the hook's JSON to a file
# in $LOOKOUT_HOOKS and send its path to this terminal as OSC 7701
# "claude-file;<path>". Lookout then knows when Claude is
# working, done or waiting. The
# user's own settings and hooks load as usual.
export LOOKOUT_TTY=$TTY
typeset -g _lookout_claude_settings=${LOOKOUT_ZDOTDIR:h}/claude-settings.json
if (( ! $+functions[claude] )); then
  function claude {
    command claude --settings "$_lookout_claude_settings" "$@"
  }
fi
