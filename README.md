# yena

A terminal workspace with an assistant. yena is a small host that loads modules: the terminal UI and console (`core`), a chat that runs Claude Code through the Agent SDK (`claude`), projects, tasks, a scheduler, an encrypted credential store (`account`) and more. Everything runs in a Docker container.

yena is an independent project. It is not made, endorsed or supported by Anthropic. It runs the unmodified Claude Code published by Anthropic.

## Requirements

- Docker with Compose v2
- A POSIX shell (Linux or macOS)
- An Anthropic API key (recommended), or your own Claude subscription (see [Anthropic's rules](#anthropics-rules))

## Quick start

```sh
git clone https://github.com/hyenayena/yena.git
cd yena
./yena build   # builds the image; the official modules in yena-modules.json are fetched over https
./yena         # starts the app (and the container, when it is not running)
```

The checkout folder must be named `yena`. Its parent folder is mounted as `/workplace` (your projects); set `YENA_WORKPLACE=<dir>` to mount another folder. App data (settings, chat history, encrypted credentials) lives in `./.yena`, outside the image.

`./yena help` lists the script's commands. Any other word runs a console line of the app, e.g. `./yena mod list` (`./yena console help` for the app's own help).

## Signing in

Pick one:

- **API key (recommended):** export `ANTHROPIC_API_KEY` on the host before `./yena` starts the container, or store a key in the app: `mod install account`, then `account grant claude` and `claude auth add` (hidden input; the key is encrypted at rest).
- **Your own Claude subscription:** `claude auth login` runs Claude Code's own sign-in. yena does not store this login; Claude Code keeps it in its own config.

`claude auth status` shows which account a new chat uses. Open the chat with `chat`.

## Anthropic's rules

Using Claude through yena is subject to Anthropic's terms: the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) for subscriptions, the [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) for API keys, the [Usage Policy](https://www.anthropic.com/legal/aup) and Claude Code's [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page. In short:

- Use only accounts that are your own. Do not share credentials or run yena for other people on your account.
- A subscription is for ordinary, individual use, signed in only through Claude Code's own login. yena stores no claude.ai login or subscription token and never switches accounts at a usage limit.
- Anything automated or unattended uses an API key. Chats started by yena's scheduler run only on an API key; do not script Claude Code on a subscription (e.g. from a scheduled shell job).
- Building something for other people on top of yena: use API keys, each user with their own.

Details: the `claude` module README, section "Policy caveat".

## Development

- `./yena dev check [suite…]` typechecks and tests the host and the modules (`host` and module names; none = all).
- In dev mode (`mode dev` in the app) yena starts from this checkout, so code changes apply after a restart; otherwise they reach the image with `./yena build` and `./yena rebuild`.
- Modules live in `modules/` (gitignored), one repository each under [github.com/hyenayena](https://github.com/hyenayena); `mod install|update|remove|list|fix|lock` manages them.

## License

MIT, see [LICENSE](LICENSE).
