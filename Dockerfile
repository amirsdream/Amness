# Portable Amness: one small image, any machine. Type stripping needs Node >= 22.18; no build step, no runtime deps
# (the Anthropic SDK is installed so the Claude provider works).
FROM node:24-alpine
WORKDIR /opt/amness
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund @anthropic-ai/sdk@^1.3.0
COPY src ./src
COPY cli ./cli
COPY examples/cases.ts ./examples/cases.ts
RUN apk add --no-cache git grep
WORKDIR /work
ENTRYPOINT ["node", "--no-warnings", "/opt/amness/cli/amness.ts"]
# docker build -t amness .
# docker run -it --rm -v "$PWD":/work -e ANTHROPIC_API_KEY amness                       # interactive menu
# docker run --rm -v "$PWD":/work -e ANTHROPIC_API_KEY amness run --provider anthropic --verify "npm test" "fix the bug"
