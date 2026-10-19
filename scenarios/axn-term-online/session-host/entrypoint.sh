#!/bin/sh
# Starts an inner dockerd when the session host runs as root — used by the
# "docker inside the session" feature, typically combined with the kata
# runtime (SESSION_HOST_RUNTIME=kata) so the inner daemon and everything
# it spawns stay inside the per-session VM. Set INNER_DOCKERD=0 to disable.

# The gateway's per-container secret is for the session host process only —
# keep it out of everything started below (runuser -u keeps the env).
session_host_secret="${AXN_SESSION_HOST_SECRET:-}"
unset AXN_SESSION_HOST_SECRET

if [ "$(id -u)" = "0" ]; then
    # Give the session a real user account so the PTY runs as the keycloak
    # user with a proper home dir instead of root. PTY_USER tells the
    # SessionHost to spawn the shell via runuser -l.
    session_user="${KEYCLOAK_USERNAME:-axn}"
    if ! printf '%s' "$session_user" | grep -qE '^[a-z_][a-z0-9_-]{0,31}$'; then
        session_user=axn
    fi
    if [ "$session_user" != "root" ] && ! id "$session_user" >/dev/null 2>&1; then
        # /home/<user> may be a mounted persistent volume — the mount point
        # already exists, so useradd -m only warns. Seed it from skel when
        # empty and take ownership (fresh volumes arrive root-owned).
        # PUID/PGID pin the session user to the host account's ids so
        # bind-mounted host dirs (DATA_MOUNT) stay writable — without this
        # the PTY runs as an arbitrary uid that can't write the mount. When
        # a different account already owns that uid (the base image's
        # ubuntu:1000), rename it instead of useradd -o'ing a second entry:
        # getpwuid() returns the first match, so the foreign name would
        # still win the prompt/whoami lookups.
        session_uid="${PUID:-}"
        session_gid="${PGID:-}"
        if [ -n "$session_uid" ]; then
            uid_owner="$(getent passwd "$session_uid" | cut -d: -f1)"
            if [ -n "$uid_owner" ]; then
                if ! usermod -l "$session_user" -d "/home/$session_user" -m "$uid_owner" 2>/dev/null; then
                    # -m fails when /home/<user> exists already (mounted
                    # home volume) — just repoint the passwd field then.
                    usermod -l "$session_user" -d "/home/$session_user" "$uid_owner"
                    mkdir -p "/home/$session_user"
                fi
                # The personal group keeps the old account's name — rename
                # it so `id` shows the keycloak user, not e.g. ubuntu.
                getent group "$uid_owner" >/dev/null 2>&1 \
                    && groupmod -n "$session_user" "$uid_owner" 2>/dev/null
            else
                [ -n "$session_gid" ] && ! getent group "$session_gid" >/dev/null 2>&1 \
                    && groupadd -o -g "$session_gid" "$session_user"
                useradd -o -u "$session_uid" ${session_gid:+-g "$session_gid"} \
                    -m -s /bin/bash "$session_user"
            fi
        else
            useradd -m -s /bin/bash "$session_user"
        fi
        # Fallback: never leave the session without its account.
        id "$session_user" >/dev/null 2>&1 || useradd -m -s /bin/bash "$session_user"
        usermod -aG docker "$session_user" 2>/dev/null || true
        user_home="/home/$session_user"
        if [ -d "$user_home" ]; then
            if [ -z "$(ls -A "$user_home" 2>/dev/null)" ]; then
                cp -a /etc/skel/. "$user_home/" 2>/dev/null || true
                chown -R "$session_user:$session_user" "$user_home" 2>/dev/null || true
            fi
            chown -h "$session_user:$session_user" "$user_home" 2>/dev/null || true
        fi
    fi
    user_home="/home/$session_user"
    [ "$session_user" = "root" ] && user_home=/root

    # Everything below that touches the (user-writable, persistent) home
    # runs as the session user: as root, a planted symlink would turn a
    # mkdir/chown/log redirect into a write to /etc and friends.
    as_user() {
        if [ "$session_user" = "root" ]; then
            "$@"
        else
            runuser -u "$session_user" -- "$@"
        fi
    }

    # Demo repos: copy each /opt/demo-seed/* into the user's home on first
    # spawn and git-init it, so sessions land on real repositories (the
    # dev-workflow plugin resolves tracking files against the repo root).
    # SEED_DEMO_REPOS=0 disables.
    if [ "${SEED_DEMO_REPOS:-1}" != "0" ] && [ -d /opt/demo-seed ]; then
        for seed in /opt/demo-seed/*; do
            [ -d "$seed" ] || continue
            name="$(basename "$seed")"
            dest="$user_home/$name"
            # -L too: a dangling symlink fails -e but would still be followed.
            if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
                as_user cp -R "$seed" "$dest" 2>/dev/null || continue
                as_user sh -c \
                    "cd '$dest' && git init -q && git add -A \
                     && git -c user.name=demo -c user.email=demo@local \
                        commit -qm 'initial commit'" \
                    >/dev/null 2>&1 || true
            fi
        done
    fi

    # Nix: when the gateway mounted a per-user volume at /nix, seed it once
    # from the image's baked-in store and hand it to the session user —
    # each user's store is private and survives recreation. nix builds are
    # unsandboxed (no userns inside the session host) with flakes enabled.
    if [ -d /nix ] && [ -d /opt/nix-seed ]; then
        if [ -z "$(ls -A /nix 2>/dev/null)" ]; then
            cp -a /opt/nix-seed/. /nix/ \
                && chown -R "$session_user:$session_user" /nix 2>/dev/null || true
        fi
        if [ "${AXN_USER_NIX_MANAGED:-0}" = "1" ]; then
            # ~/.config/nix is bind-mounted from the user's data dir — make
            # sure it exists and is owned by the session user (not root).
            as_user mkdir -p "$user_home/.config/nix" 2>/dev/null || true
        fi
        mkdir -p /etc/nix
        printf 'sandbox = false\nbuild-users-group =\nexperimental-features = nix-command flakes\n' \
            > /etc/nix/nix.conf
        # profile.d covers login shells; bash.bashrc covers the interactive
        # non-login shell the PTY spawns (runuser --reuid is not a login).
        printf 'export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"\n' \
            > /etc/profile.d/nix.sh
        grep -q '.nix-profile/bin' /etc/bash.bashrc 2>/dev/null \
            || printf 'export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"\n' \
                >> /etc/bash.bashrc
    fi

    # Per-user declarative environment — all sources are optional and live
    # in the persistent home, so they survive recreation and the user can
    # edit them in place:
    #   ~/.config/axn-term/nix-flake    home-manager flake ref (wins over
    #                                  the AXN_NIX_FLAKE deployment default)
    #   ~/.config/axn-term/nix-packages one "nix profile install" arg per line
    #   ~/.axn-term/bootstrap.sh        imperative escape hatch
    # Runs in the background — a first home-manager switch can take minutes.
    # The log redirections sit inside the user's shell for the same reason.
    state_dir="$user_home/.local/state/axn-term"
    as_user mkdir -p "$state_dir" 2>/dev/null || true
    nix_flake=""
    if as_user test -f "$user_home/.config/axn-term/nix-flake"; then
        nix_flake="$(as_user head -n1 "$user_home/.config/axn-term/nix-flake")"
    elif [ -n "${AXN_NIX_FLAKE:-}" ]; then
        nix_flake="$AXN_NIX_FLAKE"
    fi
    (
        if [ -d /nix ]; then
            if [ -n "$nix_flake" ]; then
                runuser -l "$session_user" -c \
                    "nix run home-manager/master -- switch --flake '$nix_flake' \
                     >> '$state_dir/nix-setup.log' 2>&1" || true
            fi
            if as_user test -f "$user_home/.config/axn-term/nix-packages"; then
                runuser -l "$session_user" -c \
                    "xargs -a '$user_home/.config/axn-term/nix-packages' -r nix profile install \
                     >> '$state_dir/nix-setup.log' 2>&1" || true
            fi
        fi
        if as_user test -x "$user_home/.axn-term/bootstrap.sh"; then
            runuser -l "$session_user" -c "'$user_home/.axn-term/bootstrap.sh' \
                >> '$state_dir/bootstrap.log' 2>&1" || true
        fi
    ) &
    export PTY_USER="$session_user"
fi

if [ "$(id -u)" = "0" ] && [ "${INNER_DOCKERD:-1}" != "0" ]; then
    # The OCI spec mounts /proc/sys and cgroupfs read-only; under kata these
    # are the VM's own mounts — safe to reopen rw so an inner dockerd can
    # write sysctls and create cgroups for its containers.
    mount -o remount,bind,rw /proc/sys 2>/dev/null || true
    mount -o remount,rw /sys/fs/cgroup 2>/dev/null || true
    # On custom networks Docker points resolv.conf at its embedded resolver
    # (127.0.0.11), which is unreachable inside a kata guest. Fall back to
    # public DNS so the inner dockerd can pull images.
    if grep -q "127\.0\.0\.11" /etc/resolv.conf 2>/dev/null; then
        printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
    fi
    dockerd >/var/log/dockerd.log 2>&1 &
fi

# Hand the secret to the session host as a file it alone can read. An env
# var would be inherited by every PTY and exec child: the host spawns them
# from the native environ, which .NET's SetEnvironmentVariable never touches.
if [ -n "$session_host_secret" ]; then
    secret_dir=/run/axn-session-host
    [ "$(id -u)" = "0" ] || secret_dir="$(mktemp -d)"
    mkdir -p "$secret_dir"
    chmod 700 "$secret_dir"
    (umask 077 && printf '%s' "$session_host_secret" > "$secret_dir/secret")
    export AXN_SESSION_HOST_SECRET_FILE="$secret_dir/secret"
fi
unset session_host_secret
exec "$@"
