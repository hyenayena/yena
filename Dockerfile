FROM node:24-alpine
# git (+ ssh for git@ URLs) is used by `mod install` to download modules; bubblewrap and socat run the
# chat's Bash in its sandbox (modules/claude src/chat/sandbox.ts)
RUN apk add --no-cache git openssh-client bash ripgrep bubblewrap socat
# GitHub's published host keys (docs.github.com, "GitHub's SSH key fingerprints"), so ssh to github.com is
# verified on a fresh container without mounting the host's known_hosts. Rebuild the image if GitHub rotates them.
RUN printf '%s\n' \
	'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
	'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=' \
	'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=' \
	> /etc/ssh/ssh_known_hosts
# The account module's ssh config: git in a repository that uses an account signs through that account's
# ssh-agent, also inside the chat's Bash sandbox, whose own GIT_SSH_COMMAND bypasses core.sshCommand
# (modules/account src/agent.ts). The file is in YENA_DATA, which the sandbox cannot write.
RUN printf 'Include /data/account/ssh_config\n' > /etc/ssh/ssh_config.d/yena-account.conf
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
# The host and the local module copies (see .dockerignore). The image's /app is read-only at runtime
# (compose.yaml read_only); it changes only with ./yena build.
COPY . .
# dist/ for ./yena start; then modules: install scripts of the local copies, locked modules missing from
# the context fetched over https (no keys at build time), and the record of what went in (yena-image.json).
RUN npm run build && node --import tsx src/pm/bake.ts
CMD ["npm", "run", "dev"]
