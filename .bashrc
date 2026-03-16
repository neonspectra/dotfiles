#
# ~/.bashrc
#

# If not running interactively, don't do anything
[[ $- != *i* ]] && return

# === Platform Detection ===
# Sets __platform to one of: macos, nixos, ubuntu, linux, unknown
# Reference this variable for any platform-specific logic below.
if [[ "$OSTYPE" == "darwin"* ]]; then
	__platform="macos"
elif [ -f /etc/NIXOS ] || [ -d /etc/nixos ]; then
	__platform="nixos"
elif [ -f /etc/lsb-release ] && grep -qi ubuntu /etc/lsb-release 2>/dev/null; then
	__platform="ubuntu"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
	__platform="linux"
else
	__platform="unknown"
fi

# === History ===
HISTCONTROL=ignoreboth
HISTSIZE=1000
HISTFILESIZE=2000
shopt -s histappend

# === Shell Options ===
shopt -s checkwinsize

# === Environment ===
PS1="\[\e[00;37m\]\\$ \[\e[0m\]\[\e[00;31m\]\w\[\e[0m\]\[\e[00;37m\] \[\e[0m\]\[\e[00;36m\]\u@\h\[\e[0m\]\[\e[00;37m\] > \[\e[0m\]"
export EDITOR=nvim
export PATH="$HOME/.config/bin:$PATH"

# === Theming ===
if [[ "$__platform" != "macos" ]]; then
	export QT_STYLE_OVERRIDE=kvantum
fi

# === Color Support ===
if [[ "$__platform" == "macos" ]]; then
	export CLICOLOR=1
else
	if [ -x /usr/bin/dircolors ]; then
		test -r ~/.dircolors && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
	fi
fi

# === Aliases ===
if [ -f ~/.bash_aliases ]; then
	. ~/.bash_aliases
fi

# === Bash Completion ===
if ! shopt -oq posix; then
	if [[ "$__platform" == "macos" ]]; then
		# Homebrew bash completion
		if [ -f "$(brew --prefix 2>/dev/null)/etc/profile.d/bash_completion.sh" ]; then
			. "$(brew --prefix)/etc/profile.d/bash_completion.sh"
		fi
	else
		if [ -f /usr/share/bash-completion/bash_completion ]; then
			. /usr/share/bash-completion/bash_completion
		elif [ -f /etc/bash_completion ]; then
			. /etc/bash_completion
		fi
	fi
fi

# === GPG ===
export GNUPGHOME=~/.config/gnupg/
export GPG_TTY=$(tty)

# Set platform-appropriate pinentry if not already configured
if [ -d "$GNUPGHOME" ] && ! grep -q "^pinentry-program" "$GNUPGHOME/gpg-agent.conf" 2>/dev/null; then
	case "$__platform" in
		macos)  echo "pinentry-program /opt/homebrew/bin/pinentry-mac" >> "$GNUPGHOME/gpg-agent.conf" ;;
		nixos)  echo "pinentry-program /run/current-system/sw/bin/pinentry-curses" >> "$GNUPGHOME/gpg-agent.conf" ;;
		*)      echo "pinentry-program /usr/bin/pinentry-curses" >> "$GNUPGHOME/gpg-agent.conf" ;;
	esac
	gpg-connect-agent reloadagent /bye 2>/dev/null
fi

# === Local Secrets ===
# API keys, tokens, etc. — not committed to dotfiles
if [ -f ~/.config/secrets.env ]; then
	. ~/.config/secrets.env
fi

# === Local Overrides ===
# Machine-specific config that doesn't belong in dotfiles
if [ -f ~/.bashrc.local ]; then
	. ~/.bashrc.local
fi
