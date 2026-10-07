# The operator's runner sandbox. `acquit run` starts this image on a per-job internal network with
# the allowlisting proxy as the only route out; the clone is bind-mounted at /work, the provider key
# arrives only in the docker child's environment (`-e ANTHROPIC_API_KEY` or `-e ANTHROPIC_AUTH_TOKEN`,
# name only), and nothing in the image holds a credential or a repository.
FROM node:24-bookworm-slim

# git is what the agent inspects its clone with, and curl is how a command runner reaches the proxy
# without extra tooling. The base slim image carries neither.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# The model CLI the claude-code runner starts. It runs with the operator's key and the sandbox
# network; the image itself never sees a key.
RUN npm install --global @anthropic-ai/claude-code \
 && npm cache clean --force

COPY run.mjs proxy.mjs allowlist.mjs /runner/
RUN chmod 0755 /runner/run.mjs /runner/proxy.mjs

# The clone is mounted here; a bare image holds no work.
WORKDIR /work
