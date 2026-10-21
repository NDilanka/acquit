#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git build-essential iptables-persistent netfilter-persistent
sudo install -d -m 0755 /etc/apt/keyrings

# NodeSource's signed Node 24 repository supports Ubuntu ARM64.
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
  sudo gpg --dearmor --batch --yes -o /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [arch=arm64 signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' |
  sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null

# Docker Engine, not Ubuntu's older docker.io package.
curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
  sudo gpg --dearmor --batch --yes -o /etc/apt/keyrings/docker.gpg
printf '%s\n' 'deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable' |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

# Caddy's official Cloudsmith APT repository.
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
  sudo gpg --dearmor --batch --yes -o /etc/apt/keyrings/caddy.gpg
printf '%s\n' 'deb [arch=arm64 signed-by=/etc/apt/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main' |
  sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo chmod 0644 /etc/apt/keyrings/{nodesource,docker,caddy}.gpg
sudo apt-get update
sudo apt-get install -y nodejs docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin caddy
sudo systemctl stop caddy
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu

sudo install -d -m 0755 -o ubuntu -g ubuntu /opt/acquit
if [ ! -e /opt/acquit/.git ]; then
  git clone --branch main --depth 1 https://github.com/NDilanka/acquit.git /opt/acquit
fi
cd /opt/acquit
# One-time provisioner. The revision to serve is checked out by the deploy driver before this runs.
npm ci
npm --prefix apps/web run build
sudo docker pull --platform linux/arm64 node:24-bookworm-slim
sudo docker build --platform linux/arm64 -t acquit/runner-node20 packages/runner
sudo install -d -m 0700 -o ubuntu -g ubuntu /var/lib/acquit
sudo install -d -m 0700 -o ubuntu -g ubuntu /var/lib/acquit/droid-home
# droid's installer writes ~/.local/bin/droid, which ProtectHome hides from the API unit.
if [ -x /home/ubuntu/.local/bin/droid ]; then
  sudo install -m 0755 /home/ubuntu/.local/bin/droid /usr/local/bin/droid
fi
sudo install -d -m 0700 /etc/acquit
printf '%s\n' 'Install and ARM64 image builds complete.'
node --version
npm --version
git --version
gcc --version | grep '^gcc'
sudo docker version --format 'Docker client {{.Client.Version}}, server {{.Server.Version}}'
caddy version
