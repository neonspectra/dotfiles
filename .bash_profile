# .bash_profile

# Get the aliases and functions
if [ -f ~/.bashrc ]; then
	. ~/.bashrc
fi

# User specific environment and startup programs

PATH=$PATH:$HOME/.local/bin:$HOME/bin

export PATH
#export PATH="/usr/local/opt/qt/bin:$PATH"
#export PATH="/usr/local/Cellar/qt/5.12.2/bin:$PATH"
#export XKB_DEFAULT_LAYOUT="us,us"
#export XKB_DEFAULT_OPTIONS="caps:none"
export DESKTOP="KDE"

#test -e "${HOME}/.iterm2_shell_integration.bash" && source "${HOME}/.iterm2_shell_integration.bash"
export PATH=/opt/homebrew/bin:/Users/neon/.config/bin:/Users/neon/.nix-profile/bin:/run/current-system/sw/bin:/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin:/Users/neon/.local/bin:/Users/neon/bin

# Added by OrbStack: command-line tools and integration
# This won't be added again if you remove it.
source ~/.orbstack/shell/init.bash 2>/dev/null || :
