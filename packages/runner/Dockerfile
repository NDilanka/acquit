# The operator's runner sandbox. `acquit run` starts this image on a per-job internal network with
# the allowlisting proxy as the only route out; the clone is bind-mounted at /work, a provider key
# arrives only in the docker child's environment (`-e ANTHROPIC_API_KEY`, `-e ANTHROPIC_AUTH_TOKEN`,
# or `-e FACTORY_API_KEY`, name only), and nothing in the image holds a credential or a repository.
FROM node:24-bookworm-slim

# git is what the agent inspects its clone with, and curl is how a command runner reaches the proxy
# without extra tooling. The base slim image carries neither.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# The model CLIs the runners start. They run with the operator's key and the sandbox network; the
# image itself never sees a key.
RUN npm install --global @anthropic-ai/claude-code \
 && npm cache clean --force

# droid is installed from Factory's official release channel at the pinned version, the same pick
# the official installer (https://app.factory.ai/cli) makes for linux: x64, or the AVX2 baseline
# build when the CPU needs it, or arm64 -- and the published sha256 is checked before the binary is
# installed. (The 0.238.0 sha256 values are pinned here so a build never trusts a checksum fetched
# from the same channel at build time.)
ARG TARGETARCH
RUN set -eu; \
	TARGETARCH="${TARGETARCH:-$(uname -m | sed -e 's/^x86_64$/amd64/' -e 's/^aarch64$/arm64/')}"; \
	case "$TARGETARCH" in \
		amd64) if grep -qi avx2 /proc/cpuinfo 2>/dev/null; then droid_arch=x64; else droid_arch=x64-baseline; fi ;; \
		arm64) droid_arch=arm64 ;; \
		*) echo "droid: no pinned release for architecture '$TARGETARCH'" >&2; exit 1 ;; \
	esac; \
	case "$droid_arch" in \
		x64)          droid_sha=2deb736d25c8713ca4b76cdb37251d19ff7122b497b67717563fcf6e3febbf0a ;; \
		x64-baseline) droid_sha=a6451f315d210607ef30b0230a87e50687c26aa1b00826864ac4416c5e3dd75d ;; \
		arm64)        droid_sha=b62bbc7caff53dc9e17a93f9d670c6e9b04ef348155c8f6f96e6c97024e2d1fd ;; \
	esac; \
	curl -fsSL -o /tmp/droid "https://downloads.factory.ai/factory-cli/releases/0.238.0/linux/$droid_arch/droid" \
 && echo "$droid_sha  /tmp/droid" | sha256sum -c - \
 && install -m 0755 /tmp/droid /usr/local/bin/droid \
 && rm -f /tmp/droid \
 && droid --version

COPY run.mjs proxy.mjs allowlist.mjs /runner/
RUN chmod 0755 /runner/run.mjs /runner/proxy.mjs

# The clone is mounted here; a bare image holds no work.
WORKDIR /work
