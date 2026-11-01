# /etc/zshrc put the history file in this folder; it belongs with the user's.
[[ $HISTFILE == "$LOOKOUT_ZDOTDIR"/* ]] && HISTFILE=${LOOKOUT_USER_ZDOTDIR:-$HOME}/.zsh_history

# Hand ZDOTDIR back before the user's .zshrc, so it runs as in any terminal and
# zsh finds the user's .zlogin and .zlogout afterwards.
if [[ -n $LOOKOUT_USER_ZDOTDIR ]]; then
  ZDOTDIR=$LOOKOUT_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
[[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]] && . "${ZDOTDIR:-$HOME}/.zshrc"

. "$LOOKOUT_ZDOTDIR/lookout.zsh"
