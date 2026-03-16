# .bash_profile
# Login shell startup — sources .bashrc for environment and interactive config.
# On macOS this is the primary shell startup file; on Linux .profile usually
# handles this, but .bash_profile takes precedence when it exists.

# Source .bashrc (environment + interactive config)
if [ -f ~/.bashrc ]; then
	. ~/.bashrc
fi

# Platform-specific login additions
if [[ "$OSTYPE" == "darwin"* ]]; then
	# macOS: OrbStack CLI integration
	source ~/.orbstack/shell/init.bash 2>/dev/null || :
fi
