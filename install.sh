#!/bin/sh
# Installer for yena: curl -fsSL <url>/install.sh | sh
set -eu

REPO_URL='https://github.com/hyenayena/yena.git'
MARK='# yena launcher, written by the yena installer (install.sh)'

paint() {
	if [ -z "${NO_COLOR:-}" ] && [ -t "$1" ]; then
		printf '\033[%sm%s\033[0m' "$2" "$3"
	else
		printf '%s' "$3"
	fi
}

say() {
	printf '%s\n' "$*"
}

heading() {
	paint 1 1 "$*"
	printf '\n'
}

warn() {
	{
		paint 2 33 'Warning:'
		printf ' %s\n' "$*"
	} >&2
}

die() {
	{
		paint 2 31 'Error:'
		printf ' %s\n' "$*"
	} >&2
	exit 1
}

die_build() {
	die "yena $1 failed (exit $2). Fix the problem and run the installer again, or run $target/yena build yourself."
}

check_prereqs() {
	command -v git >/dev/null 2>&1 ||
		die 'git is not installed. Install git, then run the installer again.'
	command -v docker >/dev/null 2>&1 ||
		die 'Docker is not installed. Install Docker (Docker Desktop on macOS), then run the installer again.'
	docker compose version >/dev/null 2>&1 ||
		die 'Docker Compose v2 is missing (the docker compose plugin). Install it, then run the installer again.'
	docker info >/dev/null 2>&1 ||
		die 'Docker does not answer. Start Docker Desktop or the docker service (on Linux your user may need to be in the docker group), then run the installer again.'
	[ -n "${HOME:-}" ] || die 'HOME is not set.'
}

choose_folder() {
	nl='
'
	case $HOME in *"$nl"*) die 'HOME contains a newline.' ;; esac

	if [ -n "${YENA_WORKPLACE:-}" ]; then
		raw=$YENA_WORKPLACE
	elif (: </dev/tty) 2>/dev/null; then
		printf 'Projects folder (yena goes into <folder>/yena) [~/Projects]: ' >/dev/tty
		ans=''
		read -r ans </dev/tty || ans=''
		raw=${ans:-$HOME/Projects}
	else
		raw=$HOME/Projects
		say "No terminal to ask on; using the default projects folder $raw"
	fi

	case $raw in *"$nl"*) die 'The projects folder must not contain a newline.' ;; esac
	case $raw in
	'~') raw=$HOME ;;
	'~/'*) raw=$HOME/${raw#'~/'} ;;
	'~'*) die "Use a full path for the projects folder, not $raw" ;;
	/*) ;;
	*) raw=$PWD/$raw ;;
	esac

	mkdir -p -- "$raw" || die "Could not create $raw"
	folder=$(CDPATH= cd -- "$raw" && pwd -P) || die "Could not enter $raw"
	home_phys=$(CDPATH= cd -- "$HOME" && pwd -P) || die "Could not enter $HOME"
	if [ "$folder" = / ] || [ "$folder" = "$home_phys" ]; then
		die 'Pick a folder for your projects, not your home folder (it is mounted into the container as /workplace).'
	fi
	target=$folder/yena
}

is_checkout() {
	[ -d "$target/.git" ] && [ -f "$target/yena" ] &&
		[ -f "$target/compose.yaml" ] && [ -f "$target/src/cli.ts" ]
}

# The whole body sits in functions and main runs on the last line: a download
# cut short by `curl | sh` must run nothing.
install_checkout() {
	action=installed
	if [ -e "$target" ] || [ -L "$target" ]; then
		is_checkout || die "$target exists but is not a yena checkout; left untouched. Move it away or pick another projects folder."
		action=updated
		changes=$(git -C "$target" status --porcelain --untracked-files=no) ||
			die "Could not read the git status of $target."
		[ -z "$changes" ] ||
			die "$target has local changes; commit or stash them yourself, then run the installer again."
		git -C "$target" pull --ff-only ||
			die "Could not fast-forward $target (it has diverged from the remote or its branch tracks no remote branch). Update it yourself with git, then run the installer again."
		say 'Recreating the container (a running yena app stops).'
		"$target/yena" build || die_build build $?
		"$target/yena" rebuild || die_build rebuild $?
	else
		git clone "$REPO_URL" "$target" ||
			die "git clone failed. Check your network, then run the installer again."
		"$target/yena" build || die_build build $?
	fi
}

install_launcher() {
	launcher_ok=0
	L=$HOME/.local/bin/yena
	if { [ -e "$L" ] || [ -L "$L" ]; } &&
		! { [ -f "$L" ] && ! [ -L "$L" ] && grep -qF -- "$MARK" "$L"; }; then
		warn "~/.local/bin/yena exists and was not written by this installer; left as is. Remove it and run the installer again, or start yena with $target/yena."
		return 0
	fi

	mkdir -p -- "$HOME/.local/bin" || die 'Could not create ~/.local/bin'
	quoted=$(printf '%s' "$target/yena" | sed "s/'/'\\\\''/g")
	tmp=$HOME/.local/bin/.yena.tmp.$$
	{
		printf '#!/bin/sh\n%s\n' "$MARK"
		printf "exec '%s' \"\$@\"\n" "$quoted"
	} >"$tmp" || die 'Could not write the launcher.'
	chmod 755 "$tmp" && mv -f -- "$tmp" "$L" || {
		rm -f -- "$tmp"
		die 'Could not install the launcher.'
	}
	launcher_ok=1

	case ":$PATH:" in
	*":$HOME/.local/bin:"*) on_path=1 ;;
	*)
		on_path=0
		sh_name=${SHELL:-}
		case ${sh_name##*/} in
		zsh) rc='~/.zshrc' ;;
		bash) rc='~/.bashrc' ;;
		*) rc='~/.zshrc or ~/.bashrc' ;;
		esac
		say "~/.local/bin is not on your PATH. Add it ($rc), then open a new terminal:"
		say 'export PATH="$HOME/.local/bin:$PATH"'
		;;
	esac
}

summary() {
	say ''
	heading "yena $action in $target"
	say "Projects folder (mounted as /workplace): $folder"
	say ''
	say 'Next:'
	if [ "$launcher_ok" = 1 ] && [ "$on_path" = 1 ]; then
		cmd=yena
	else
		cmd=$target/yena
	fi
	say "  $cmd         start yena"
	say "  $cmd help    list the commands"
	say '  Sign in:     see "Signing in" in the README'
}

main() {
	on_path=0
	check_prereqs
	choose_folder
	install_checkout
	install_launcher
	summary
}

main "$@"
