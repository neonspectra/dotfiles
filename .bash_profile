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
