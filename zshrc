typeset -U path PATH

# Persist executed commands across terminal sessions.
HISTFILE="${ZDOTDIR:-$HOME}/.zsh_history"
HISTSIZE=100000
SAVEHIST=100000
setopt APPEND_HISTORY
setopt INC_APPEND_HISTORY
setopt SHARE_HISTORY
setopt HIST_EXPIRE_DUPS_FIRST
setopt HIST_IGNORE_DUPS
setopt HIST_SAVE_NO_DUPS

autoload -Uz compinit
compinit -C

# Standalone plugins (installed from their upstream repositories).
source "$HOME/.zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
bindkey '^F' autosuggest-accept

# Move by words with Ctrl+Left/Right instead of deleting text. These are the
# escape sequences emitted by common terminals, including through tmux.
# Treat slash and hyphen as separators so paths and hyphenated names are
# traversed one component at a time instead of as one full word.
WORDCHARS=${WORDCHARS//[-\/]/}

# Ctrl+Shift+Left/Right should use full words, including "/" and "-".
_zsh_whole_word_backward() {
  local wordchars="$WORDCHARS"
  local WORDCHARS="${wordchars}/-"
  zle backward-word
}
_zsh_whole_word_forward() {
  local wordchars="$WORDCHARS"
  local WORDCHARS="${wordchars}/-"
  zle forward-word
}
zle -N _zsh_whole_word_backward
zle -N _zsh_whole_word_forward

for keymap in emacs viins; do
  bindkey -M "$keymap" '^[b' backward-word
  bindkey -M "$keymap" '^[f' forward-word
  bindkey -M "$keymap" '^[[1;5D' backward-word
  bindkey -M "$keymap" '^[[1;5C' forward-word
  bindkey -M "$keymap" '^[[5D' backward-word
  bindkey -M "$keymap" '^[[5C' forward-word
  bindkey -M "$keymap" '^[[1;6D' _zsh_whole_word_backward
  bindkey -M "$keymap" '^[[1;6C' _zsh_whole_word_forward
  bindkey -M "$keymap" '^[[6D' _zsh_whole_word_backward
  bindkey -M "$keymap" '^[[6C' _zsh_whole_word_forward
done

source "$HOME/.zsh/plugins/zsh-history-substring-search/zsh-history-substring-search.zsh"

# Cycle matching command history with the arrow keys.
# This stable plugin behavior replaces BUFFER with the selected history entry.
[[ -n ${terminfo[kcuu1]:-} ]] && bindkey "$terminfo[kcuu1]" history-substring-search-up
[[ -n ${terminfo[kcud1]:-} ]] && bindkey "$terminfo[kcud1]" history-substring-search-down

source "$HOME/.zsh/plugins/zsh-z/zsh-z.plugin.zsh"

# Load the Steeef prompt directly, without initializing the Oh My Zsh framework.
# The upstream theme expects Oh My Zsh's conda_prompt_info helper.
conda_prompt_info() {
  [[ -n ${CONDA_DEFAULT_ENV:-} ]] && print -n "(${CONDA_DEFAULT_ENV}) "
}
source "$HOME/.oh-my-zsh/themes/steeef.zsh-theme"

# User configuration

# Shared environment used by both zsh and Pi.
[ -r "$HOME/env.sh" ] && source "$HOME/env.sh"

# export MANPATH="/usr/local/man:$MANPATH"

# You may need to manually set your language environment
# export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
# if [[ -n $SSH_CONNECTION ]]; then
#   export EDITOR='vim'
# else
# fi


# NVM (Node Version Manager): load only when `nvm` is invoked.
# Node, npm, and npx are available immediately from the versioned PATH below.
nvm() {
  unset -f nvm
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
  nvm "$@"
}

# Rust/Cargo
unset GIT_ASKPASS

# ZSHZ options
ZSHZ_CASE=smart
ZSH_UNCOMMON=1

# bun completions
[ -s "/usr2/manurodr/.bun/_bun" ] && source "/usr2/manurodr/.bun/_bun"

# oh-my-openagent
OMO_SEND_ANONYMOUS_TELEMETRY=0
OMO_DISABLE_POSTHOG=1

# OSC52 copying
osc52_copy() {
  printf '\033]52;c;%s\a' "$(base64 | tr -d '\n')"
}

# llama-cli
alias llama-cli='/local/mnt/workspace/manurodr/llama.cpp/build/bin/llama-cli'

# Must be sourced last; it wraps ZLE widgets for command highlighting.
source "$HOME/.zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
