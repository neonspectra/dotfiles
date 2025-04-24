
### yt-dlp ###
# Alias for downloading Youtube videos with yt-dlp in a way that embeds all video information. Uses the Android client extractor to avoid throttling.
alias yt='yt-dlp --extractor-args "youtube:player_client=android" --sponsorblock-remove sponsor,selfpromo --write-subs --write-auto-subs --embed-subs --embed-chapters --embed-thumbnail --add-metadata'

### tmux ###
# Creates a new session with given name. Attaches if a session of that name already exists.
alias tt='tmux new -A -s'

### rsync ###
# Alias cp to rsync because cp is cringe and sucks
alias cpa='rsync -avhe ssh --append-verify --partial --progress'
alias cp='rsync -avhe ssh --progress'
alias cpza='rsync -azvhe ssh --append-verify --partial --progress'
alias cpz='rsync -azvhe ssh --progress'

### gpg###
# Fixes env variable for pinentry to current term
alias gpgset='export GPG_TTY=$(tty)'

### Searches ###
# Command for recursively searching for any file with a specified name under the current directoy
alias search="find -type f -iname" # Takes commands in the form of $ search "some_shit*"
# Search the contents of all files under the current directory recursively to find a specific term
# Takes commands in the form of $ examine 'search term'. Uses ggrep if on OSX (BSD grep doesn't have the operators we are using)
if [[ "$OSTYPE" == "darwin"* ]]; then
  alias examine='ggrep -rnw . -e '
else
  alias examine='grep -rnw . -e '
fi

### Network ###
# Get the current public ip address
alias publicip='curl icanhazip.com'

### Misc ###
alias cls='clear'
# Repeat the previous command with sudo
alias fuck='sudo $(history -p \!\!)'
