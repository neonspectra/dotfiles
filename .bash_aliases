### ls ###
if [[ "$__platform" == "macos" ]]; then
	alias ls='ls -G'
else
	alias ls='ls --color=auto'
fi
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

### grep ###
if [[ "$__platform" == "macos" ]]; then
	alias grep='ggrep --color=auto'
	alias fgrep='ggrep -F --color=auto'
	alias egrep='ggrep -E --color=auto'
else
	alias grep='grep --color=auto'
	alias fgrep='fgrep --color=auto'
	alias egrep='egrep --color=auto'
fi

### yt-dlp ###
# Alias for downloading Youtube videos with yt-dlp in a way that embeds all video information.
alias yt='yt-dlp --sponsorblock-remove sponsor,selfpromo --write-subs --write-auto-subs --embed-subs --embed-chapters --embed-thumbnail --add-metadata'

### tmux ###
# Creates a new session with given name. Attaches if a session of that name already exists.
alias tt='tmux new -A -s'

### rsync ###
# Alias cp to rsync because cp is cringe and sucks
alias cpa='rsync -avhe ssh --append-verify --partial --progress'
alias cp='rsync -avhe ssh --progress'
alias cpza='rsync -azvhe ssh --append-verify --partial --progress'
alias cpz='rsync -azvhe ssh --progress'

### gpg ###
# Fixes env variable for pinentry to current term
alias gpgset='export GPG_TTY=$(tty)'

### Searches ###
# Recursively search for a file by name under cwd
if [[ "$__platform" == "macos" ]]; then
	alias search="gfind -type f -iname"
else
	alias search="find -type f -iname"
fi
# Search file contents recursively under cwd
if [[ "$__platform" == "macos" ]]; then
	alias examine='ggrep -rnw . -e '
else
	alias examine='grep -rnw . -e '
fi

### Network ###
alias publicip='curl icanhazip.com'

### Misc ###
alias cls='clear'
alias fuck='sudo $(history -p \!\!)'
