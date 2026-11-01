# Lookout starts zsh with ZDOTDIR set to this folder. Each startup file here
# loads the user's own file of the same name, then .zshrc hands ZDOTDIR back
# and adds lookout.zsh. LOOKOUT_USER_ZDOTDIR is the user's ZDOTDIR, if any.
LOOKOUT_ZDOTDIR=$ZDOTDIR
if [[ -f "${LOOKOUT_USER_ZDOTDIR:-$HOME}/.zshenv" ]]; then
  ZDOTDIR=${LOOKOUT_USER_ZDOTDIR:-$HOME}
  . "$ZDOTDIR/.zshenv"
  ZDOTDIR=$LOOKOUT_ZDOTDIR
fi
