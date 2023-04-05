#
# ~/.bashrc
#

# If not running interactively, don't do anything
[[ $- != *i* ]] && return

# Set our environment variables
PS1="\[\e[00;37m\]\\$ \[\e[0m\]\[\e[00;31m\]\w\[\e[0m\]\[\e[00;37m\] \[\e[0m\]\[\e[00;36m\]\u@\h\[\e[0m\]\[\e[00;37m\] > \[\e[0m\]"
export EDITOR=nvim
export PATH="$HOME/.config/bin:$PATH"

#Theming
export QT_STYLE_OVERRIDE=kvantum

# Import bash baliases file, separate from this for organisation
if [ -f ~/.bash_aliases ]; then
	. ~/.bash_aliases
fi

# === GPG ===
# Set all our gpg config stuff to .config/gnupg/ so that it doesn't clog up home
export GNUPGHOME=~/.config/gnupg/
# Sets the current shell as the shell to use for pinentry
export GPG_TTY=$(tty)
# ===========
