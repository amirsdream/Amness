# Portable Amness: one small image, any machine. Type stripping needs Node >= 22.18; no build step. The Anthropic SDK is installed
# so the Claude provider works; Electron (for the desktop app) is installed without its program.
FROM node:24-alpine
WORKDIR /opt/amness
COPY package.json ./
# Keys are never written inside the container: pass them as an environment variable or a Docker secret.
ENV AMNESS_KEYSTORE=none
# The desktop app is not used in a container: never download the Electron program (about 100 MB, fetched on first use).
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm install --omit=dev --no-audit --no-fund @anthropic-ai/sdk@^1.3.0
COPY src ./src
COPY cli ./cli
COPY examples/cases.ts ./examples/cases.ts
RUN apk add --no-cache git grep
WORKDIR /work
ENTRYPOINT ["node", "--no-warnings", "/opt/amness/cli/amness.ts"]
# docker build -t amness .
# docker run -it --rm -v "$PWD":/work -e ANTHROPIC_API_KEY amness                       # interactive menu (-e NAME with no value copies it from your shell, so it is not on the command line)
# a Docker secret instead of a variable: ... --secret / compose "secrets:", then -e ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic
# docker run --rm -v "$PWD":/work -e ANTHROPIC_API_KEY amness run --provider anthropic --verify "npm test" "fix the bug"
